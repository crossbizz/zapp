import { createHash, createHmac } from 'node:crypto';

import { ApiErrorSchema, newId } from '@zapp/contracts';
import {
  agentEvents,
  agentRuns,
  branches,
  conversations,
  nextEventSequence,
  projectContracts,
  projects,
} from '@zapp/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp, type AppInstance } from '../../src/app.js';
import { CSRF_COOKIE, CSRF_HEADER } from '../../src/auth/cookies.js';
import { createDbUserStore } from '../../src/auth/users.js';
import {
  DispatchNotStartedError,
  type StartRunInput,
} from '../../src/orchestrator/port.js';
import { createDbOrganizationStore, type OrganizationStore } from '../../src/orgs/store.js';
import { SERVICE_TOKEN_HEADER } from '../../src/internal/service-auth.js';
import { createInMemoryAuditSink, type InMemoryAuditSink } from '../../src/plugins/audit.js';
import { ORGANIZATION_HEADER } from '../../src/plugins/tenant.js';
import {
  createTenantDbFactory,
  type NewRunInput,
  type TenantRunRepository,
} from '../../src/tenant/db.js';
import { FakeAuthPort } from '../support/fake-auth-port.js';
import { InMemoryTenantData } from '../support/tenant-db.js';
import { createDatabaseCreditExhaustionStore } from '../../src/usage/reconciliation.js';
import { TestServiceTokens } from '../support/service-tokens.js';
import {
  TEST_AUTH_CONFIG,
  TEST_CAPABILITY_SCAN,
  TEST_MASTER_KEY,
  TEST_PRICING,
  TEST_RATE_LIMITS,
  cookieJar,
  cookiesOf,
} from '../support/harness.js';
import { hasDatabase, setUpTestDatabase, type TestDatabase } from './helpers.js';

/**
 * The M0 exit criterion, as a permanent adversarial suite: **two organizations
 * cannot access one another's projects or artifacts.**
 *
 * It is deliberately hostile. Two fully populated tenants exist, each with an
 * Owner, a Builder and a Viewer, projects, runs and events; every request below
 * is one a compromised or buggy client would actually send — someone else's id
 * in the path, someone else's id in the `x-organization-id` header, the two
 * disagreeing, a role reaching past its row in the PRD §22.2 matrix, and a
 * session with no memberships at all.
 *
 * Two rules keep it honest:
 *
 * 1. **Assertions are on ids, never on counts.** "Three rows came back" is
 *    satisfied by the wrong three. Every list assertion names the ids that must
 *    be there and the ids that must not.
 * 2. **Every refusal has a negative control.** The single most common way an
 *    isolation suite goes fake is by passing because the service refuses
 *    everything. The `negative control` block below re-issues each request with
 *    the *correct* organization and role and requires it to succeed, so a
 *    service that 404s indiscriminately fails this file just as loudly as one
 *    that leaks.
 *
 * The CI job named `tenant-isolation` runs exactly this file.
 */

/**
 * Fixed, and inside the partitions `packages/db/drizzle/0001` seeds
 * (2026-08 … 2027-07). `new Date()` would make this suite start failing in
 * August 2027 for reasons that have nothing to do with tenancy.
 */
const EVENT_TIME = new Date('2026-08-15T12:00:00.000Z');
/** Fixed only so the PostgreSQL fingerprint assertion has a hand-derived value. */
const RUN_INTENT_HMAC_KEY = Buffer.alloc(32, 0x7b);
const RUN_ACCOUNTING: NewRunInput['accounting'] = {
  baseCeiling: TEST_PRICING.defaultRunCreditCeiling,
  pricingVersion: TEST_PRICING.version,
  pricingSnapshot: TEST_PRICING,
};
const RUN_PLAN_MAX_CREDITS = TEST_PRICING.defaultRunCreditCeiling;

/**
 * The value each tenant's secret holds, prefixed with the tenant's slug so a
 * leak names which tenant leaked. Distinctive enough that a whole response body
 * can be searched for it.
 */
const SECRET_VALUE = 'hunter2-do-not-leak';

/**
 * The service the internal decrypt route is exercised as. Real allowlist, real
 * gate, real HS256 tokens (`test/support/service-tokens.ts`) — only the secret
 * is a test's. Minted per call because the route is single-use (plan 02 CP-8):
 * a token spent on one assertion is refused by the next, which is the point.
 */
const SANDBOX = 'sandbox-service';
const serviceTokens = new TestServiceTokens();
const serviceToken = (): Promise<string> => serviceTokens.issue(SANDBOX);

/** Seeding is not what this suite is about; the audit trail has its own suite. */
const noAudit = (): Promise<void> => Promise.resolve();

type Response = Awaited<ReturnType<AppInstance['inject']>>;

interface Member {
  readonly userId: string;
  readonly email: string;
  /** The `Cookie` header alone, for requests that deliberately omit CSRF. */
  readonly cookie: string;
  /** Cookie plus CSRF header — what a signed-in browser page sends. */
  readonly headers: Record<string, string>;
}

interface Tenant {
  readonly organizationId: string;
  readonly owner: Member;
  readonly builder: Member;
  readonly viewer: Member;
  /** Someone who was invited and never accepted: a row, not an access grant. */
  readonly pending: Member;
  readonly projectIds: string[];
  readonly runIds: string[];
  readonly eventIds: string[];
  readonly auditEventIds: string[];
  /** One secret per project, set through the API so the vault path is the real one. */
  readonly secretIds: string[];
}

function errorOf(response: Response): string {
  return ApiErrorSchema.parse(response.json()).error.code;
}

/** Asserts the whole refusal — status and envelope code — in one place. */
function expectRefusal(response: Response, status: number, code: string): void {
  expect(response.statusCode, response.body).toBe(status);
  expect(errorOf(response), response.body).toBe(code);
}

interface Row {
  readonly id: string;
  readonly organizationId: string;
}

function rowsOf(response: Response): Row[] {
  return response.json<{ items: Row[] }>().items;
}

/**
 * A list is clean when every row belongs to `tenant`, every id `tenant` owns is
 * present, and no id the other tenant owns is. All three, because any two of
 * them can be satisfied by an empty or a truncated answer.
 */
function expectOnlyTenantRows(response: Response, tenant: Tenant, expected: string[]): void {
  expect(response.statusCode, response.body).toBe(200);
  const rows = rowsOf(response);
  const ids = rows.map((row) => row.id);
  expect(ids).toEqual(expect.arrayContaining(expected));
  for (const row of rows) {
    expect(row.organizationId, `row ${row.id} belongs to another organization`).toBe(
      tenant.organizationId,
    );
  }
}

interface ConcurrentCreateEvidence {
  readonly outcomes: string[];
  readonly authorizations: number;
  readonly audits: number;
  readonly rows: readonly { readonly id: string }[];
}

async function exerciseConcurrentRunCreates(
  repository: TenantRunRepository,
  base: Omit<NewRunInput, 'requestFingerprint' | 'authorize' | 'audit'>,
  fingerprints: readonly [string, string],
  rows: () => Promise<readonly { readonly id: string }[]>,
): Promise<ConcurrentCreateEvidence> {
  let authorizations = 0;
  let audits = 0;
  let releaseAudit = (): void => undefined;
  const auditGate = new Promise<void>((resolve) => {
    releaseAudit = resolve;
  });
  let markAuditEntered = (): void => undefined;
  const auditEntered = new Promise<void>((resolve) => {
    markAuditEntered = resolve;
  });
  const create = (requestFingerprint: string) =>
    repository.create({
      ...base,
      requestFingerprint,
      authorize: () => {
        authorizations += 1;
      },
      audit: async () => {
        audits += 1;
        markAuditEntered();
        await auditGate;
      },
    });

  const pending = [create(fingerprints[0]), create(fingerprints[1])] as const;
  await auditEntered;
  await Promise.resolve();
  await Promise.resolve();
  releaseAudit();
  const results = await Promise.all(pending);

  return {
    outcomes: results.map((result) => result.outcome).sort(),
    authorizations,
    audits,
    rows: await rows(),
  };
}

async function withOneAvailableConnection<T>(
  database: TestDatabase,
  work: () => Promise<T>,
): Promise<{ readonly timedOut: boolean; readonly value: T }> {
  const held = await Promise.all(
    Array.from({ length: database.sql.options.max - 1 }, async () => await database.sql.reserve()),
  );
  const pending = work().then(
    (value) => ({ state: 'fulfilled' as const, value }),
    (error: unknown) => ({ state: 'rejected' as const, error }),
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const observed = await Promise.race([
    pending.then((result) => ({ state: 'settled' as const, result })),
    new Promise<{ readonly state: 'timeout' }>((resolve) => {
      timer = setTimeout(() => {
        resolve({ state: 'timeout' });
      }, 2_000);
    }),
  ]);
  if (timer !== undefined) clearTimeout(timer);
  for (const connection of held) connection.release();
  const final = await pending;
  if (final.state === 'rejected') throw final.error;
  return { timedOut: observed.state === 'timeout', value: final.value };
}

/**
 * Whether this run is a CI run — for any value CI sets, not the one GitHub
 * happens to use.
 *
 * `CI === 'true'` was a hole with a very short fuse: every other CI system
 * spells it `1`, `yes` or the name of the provider, and on any of them the
 * guard below would have quietly stopped guarding (plan 02 CP-4 review).
 */
function inContinuousIntegration(): boolean {
  const flag = (process.env['CI'] ?? '').trim().toLowerCase();
  return flag !== '' && flag !== 'false' && flag !== '0';
}

/**
 * This suite is the milestone gate, so it must not be able to pass by not
 * running. Outside the `skipIf` below on purpose: without `DATABASE_URL` every
 * assertion in this file is skipped, and a CI job that skipped them all while
 * reporting green is the exact failure the `tenant-isolation` job exists to
 * prevent.
 */
describe('the isolation suite itself', () => {
  it('refuses to be silently skipped in CI', () => {
    expect(inContinuousIntegration() ? hasDatabase : true).toBe(true);
  });
});

/**
 * How many assertions the negative-control block below must actually make.
 *
 * Counted, because the block is what stops this suite from passing by refusing
 * everything — and a `describe.skip` on it would downgrade the milestone gate to
 * exactly that, silently and with a green tick. See the guard at the end of the
 * file.
 */
const NEGATIVE_CONTROLS = 9;
let negativeControlsRun = 0;

describe.skipIf(!hasDatabase)('tenant isolation', () => {
  let database: TestDatabase;
  let store: OrganizationStore;
  let app: AppInstance;
  let baseUrl: string;
  let port: FakeAuthPort;
  let audit: InMemoryAuditSink;
  const startCalls: StartRunInput[] = [];
  let failedStarts = 0;
  let a: Tenant;
  let b: Tenant;
  /** Signed in, real session, member of nothing. */
  let nomad: Member;
  /** A Viewer in A and an Owner in B — the header is what tells them apart. */
  let bridge: Member;

  /** Drives the real login handshake; a minted token is not a session. */
  async function signIn(email: string): Promise<Member> {
    const code = `auth-code-${email}`;
    const start = await app.inject({ method: 'GET', url: '/v1/auth/login' });
    const state = new URL(start.headers.location as string).searchParams.get('state') ?? '';
    port.issueCode(code, { externalId: `external-${email}`, email, displayName: email });

    const callback = await app.inject({
      method: 'GET',
      url: `/v1/auth/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`,
      headers: { cookie: cookieJar(cookiesOf(start.headers['set-cookie'])) },
    });
    expect(callback.statusCode, callback.body).toBe(302);

    const cookies = cookiesOf(callback.headers['set-cookie']);
    const cookie = cookieJar(cookies);
    const [row] = await database.sql<{ id: string }[]>`
      select id from users where email = ${email}
    `;
    if (row === undefined) {
      throw new Error(`sign-in created no user for ${email}`);
    }
    return {
      userId: row.id,
      email,
      cookie,
      headers: { cookie, [CSRF_HEADER]: cookies.get(CSRF_COOKIE) ?? '' },
    };
  }

  /** Retires the personal workspace when this fixture assigns a different role. */
  async function retireBootstrapMembership(member: Member): Promise<void> {
    await database.sql`
      update memberships
      set status = 'removed'
      where user_id = ${member.userId} and status = 'active'
    `;
  }

  /** `member`'s headers, naming `organizationId` as the tenant for the request. */
  function as(member: Member, organizationId?: string): Record<string, string> {
    return organizationId === undefined
      ? member.headers
      : { ...member.headers, [ORGANIZATION_HEADER]: organizationId };
  }

  async function streamRows(member: Member, organizationId: string, runId: string): Promise<Row[]> {
    const controller = new AbortController();
    const response = await fetch(`${baseUrl}/v1/runs/${runId}/events`, {
      headers: { ...as(member, organizationId), accept: 'text/event-stream' },
      signal: controller.signal,
    });
    expect(response.status).toBe(200);
    const reader = response.body?.getReader();
    if (reader === undefined) throw new Error('SSE response has no body');
    const decoder = new TextDecoder();
    const rows: Row[] = [];
    let pending = '';
    try {
      while (rows.length < 2) {
        const chunk = await reader.read();
        if (chunk.done) break;
        const value: unknown = chunk.value;
        if (!(value instanceof Uint8Array)) throw new Error('SSE chunk is not bytes');
        pending += decoder.decode(value, { stream: true }).replaceAll('\r\n', '\n');
        let boundary = pending.indexOf('\n\n');
        while (boundary >= 0) {
          const block = pending.slice(0, boundary);
          pending = pending.slice(boundary + 2);
          const data = block
            .split('\n')
            .find((line) => line.startsWith('data: '))
            ?.slice('data: '.length);
          if (data !== undefined) rows.push(JSON.parse(data) as Row);
          boundary = pending.indexOf('\n\n');
        }
      }
      return rows;
    } finally {
      controller.abort();
    }
  }

  /** An organization with three active members, two projects, two runs, four events. */
  async function seedTenant(slug: string): Promise<Tenant> {
    const owner = await signIn(`owner@${slug}.test`);
    const builder = await signIn(`builder@${slug}.test`);
    const viewer = await signIn(`viewer@${slug}.test`);
    const pending = await signIn(`pending@${slug}.test`);

    const now = new Date();
    const [bootstrap] = await database.sql<{ organization_id: string }[]>`
      select organization_id
      from memberships
      where user_id = ${owner.userId} and status = 'active'
    `;
    if (bootstrap === undefined) throw new Error(`sign-in created no workspace for ${owner.email}`);
    const organizationId = bootstrap.organization_id;
    await database.sql`
      update organizations set name = ${slug}, slug = ${slug} where id = ${organizationId}
    `;
    const auditRows = await database.sql<{ id: string }[]>`
      select id from audit_events
      where organization_id = ${organizationId} and action = 'organization.created'
    `;
    const auditEventIds = auditRows.map((row) => row.id);

    await Promise.all([
      retireBootstrapMembership(builder),
      retireBootstrapMembership(viewer),
      retireBootstrapMembership(pending),
    ]);
    await store.addMember({
      organizationId,
      userId: builder.userId,
      role: 'builder',
      now,
      audit: noAudit,
    });
    await store.addMember({
      organizationId,
      userId: viewer.userId,
      role: 'viewer',
      now,
      audit: noAudit,
    });
    // Written directly: nothing in the API creates an `invited` membership row
    // today, and the rule that one is not access has to be pinned before
    // something does.
    await database.sql`
      insert into memberships (organization_id, user_id, role, status)
      values (${organizationId}, ${pending.userId}, 'builder', 'invited')
    `;

    const projectIds: string[] = [];
    const runIds: string[] = [];
    const eventIds: string[] = [];

    for (const name of ['alpha', 'beta']) {
      const projectId = newId('proj');
      await database.db.insert(projects).values({
        id: projectId,
        organizationId,
        name: `${slug} ${name}`,
        slug: `${slug}-${name}`,
        sourceType: 'prompt',
        supportLevel: 'verified',
        createdBy: owner.userId,
      });
      projectIds.push(projectId);

      const branchId = newId('br');
      await database.db
        .insert(branches)
        .values({ id: branchId, organizationId, projectId, name: 'main', status: 'active' });

      // Written directly for the same reason the runs and events above are:
      // plan 05's scan pipeline (VF-3) is what produces these, and the rule that
      // one tenant cannot read another's execution contract has to be pinned
      // before it does.
      await database.db.insert(projectContracts).values({
        id: newId('pc'),
        organizationId,
        projectId,
        version: 1,
        detectedFramework: 'next',
        contractJson: { version: 1, package_manager: 'pnpm', workspace_root: '.' },
      });

      const runId = newId('run');
      const conversationId = newId('conv');
      await database.db.insert(conversations).values({
        id: conversationId,
        organizationId,
        projectId,
        createdBy: owner.userId,
        title: `${slug} ${name}`,
      });
      await database.db.insert(agentRuns).values({
        id: runId,
        organizationId,
        projectId,
        conversationId,
        conversationRunNumber: 1,
        branchId,
        mode: 'build',
        requestFingerprint: `seed:${runId}`,
        status: 'running',
        startedBy: owner.userId,
        planMaxCredits: '1000.0000',
      });
      runIds.push(runId);

      for (let index = 0; index < 2; index += 1) {
        const id = newId('evt');
        const sequence = await nextEventSequence(database.db, runId);
        await database.db.insert(agentEvents).values({
          id,
          organizationId,
          runId,
          sequence,
          projectId,
          type: 'tool.completed',
          payloadJson: { tool: 'run_build', exitCode: 0, userSummary: 'Ran the build' },
          visibility: 'user',
          occurredAt: EVENT_TIME,
        });
        eventIds.push(id);
      }
    }

    // Through the API rather than by insert, deliberately: the ciphertext, the
    // envelope and the `secret_metadata` row all have to be the ones the
    // shipping write path produces, or the cross-tenant reads below would be
    // reading a fixture rather than a secret.
    const secretIds: string[] = [];
    for (const projectId of projectIds) {
      const response = await app.inject({
        method: 'POST',
        url: `/v1/projects/${projectId}/secrets`,
        headers: as(owner, organizationId),
        payload: { name: 'DATABASE_URL', value: `${slug}-${SECRET_VALUE}` },
      });
      expect(response.statusCode, response.body).toBe(201);
      secretIds.push(response.json<{ secret: { id: string } }>().secret.id);
    }

    return {
      organizationId,
      owner,
      builder,
      viewer,
      pending,
      projectIds,
      runIds,
      eventIds,
      auditEventIds,
      secretIds,
    };
  }

  beforeAll(async () => {
    database = await setUpTestDatabase();
    await database.truncateIdentity();
    store = createDbOrganizationStore(database.db);
    port = new FakeAuthPort();
    audit = createInMemoryAuditSink();
    app = buildApp({
      logger: false,
      auth: { port, users: createDbUserStore(database.db), config: TEST_AUTH_CONFIG },
      orgs: { organizations: store, audit },
      tenant: {
        tenantDb: createTenantDbFactory(database.db),
        runIntentHmacKey: RUN_INTENT_HMAC_KEY,
        pricing: TEST_PRICING,
        capabilityScan: TEST_CAPABILITY_SCAN,
        orchestrator: {
          startRun: (input) => {
            startCalls.push(input);
            if (failedStarts > 0) {
              failedStarts -= 1;
              return Promise.reject(new DispatchNotStartedError());
            }
            return Promise.resolve();
          },
          signalRun: () => Promise.resolve({ applied: true }),
        },
      },
      // The vault, wired exactly as `composeApp` wires it but with a token
      // verifier a test can issue from — CP-8 ships the real one.
      secrets: { masterKey: TEST_MASTER_KEY, serviceTokens: serviceTokens.verifier },
      // Rate limiting is registered exactly as it is in production — this suite
      // just needs the numbers out of the way, since eleven sign-ins from one
      // address is more than the shipped ten-a-minute auth ceiling. The limits
      // themselves are `test/plugins.test.ts`'s subject.
      limits: { config: TEST_RATE_LIMITS },
    });
    baseUrl = await app.listen({ host: '127.0.0.1', port: 0 });

    a = await seedTenant('acme');
    b = await seedTenant('beta');

    nomad = await signIn('nomad@nowhere.test');
    await retireBootstrapMembership(nomad);
    bridge = await signIn('bridge@both.test');
    await retireBootstrapMembership(bridge);
    const now = new Date();
    await store.addMember({
      organizationId: a.organizationId,
      userId: bridge.userId,
      role: 'viewer',
      now,
      audit: noAudit,
    });
    await store.addMember({
      organizationId: b.organizationId,
      userId: bridge.userId,
      role: 'owner',
      now,
      audit: noAudit,
    });
  }, 180_000);

  afterAll(async () => {
    await app.close();
    await database.close();
  });

  describe('real PostgreSQL run intent behavior', () => {
    it('persists and reads the omitted web/null defaults', async () => {
      const beforeAudit = audit.events.length;
      const beforeStarts = startCalls.length;
      const response = await app.inject({
        method: 'POST',
        url: `/v1/projects/${a.projectIds[0] ?? ''}/runs`,
        headers: {
          ...as(a.owner, a.organizationId),
          'idempotency-key': 'postgres-default-run-intent-01',
        },
        payload: { mode: 'build', prompt: 'Persist PostgreSQL defaults' },
      });

      expect(response.statusCode, response.body).toBe(201);
      const created = response.json<{
        run: { id: string; appType: string; model: string | null };
      }>().run;
      expect(created).toMatchObject({ appType: 'web', model: null });

      const [row] = await database.sql<{ app_type: string; model: string | null }[]>`
        select app_type, model from agent_runs where id = ${created.id}
      `;
      expect(row).toEqual({ app_type: 'web', model: null });
      const [account] = await database.sql<{
        base_ceiling: string;
        pricing_version: string;
        default_ceiling: string;
      }[]>`
        select
          base_ceiling::text as base_ceiling,
          pricing_version,
          pricing_snapshot_json ->> 'defaultRunCreditCeiling' as default_ceiling
        from run_credit_accounts
        where run_id = ${created.id} and organization_id = ${a.organizationId}
      `;
      expect(account).toEqual({
        base_ceiling: '1000.0000',
        pricing_version: 'm1-test',
        default_ceiling: '1000.0000',
      });

      const read = await app.inject({
        method: 'GET',
        url: `/v1/runs/${created.id}`,
        headers: as(a.owner, a.organizationId),
      });
      expect(read.statusCode, read.body).toBe(200);
      expect(read.json<{ run: { appType: string; model: string | null } }>().run).toMatchObject({
        appType: 'web',
        model: null,
      });
      expect(
        audit.events
          .slice(beforeAudit)
          .filter((event) => event.action === 'run.created' && event.targetId === created.id),
      ).toHaveLength(1);
      expect(startCalls.slice(beforeStarts)).toEqual([
        expect.objectContaining({ runId: created.id, appType: 'web', model: null }),
      ]);
    });

    it('recovers one explicit row and audit after a failed dispatch without current policy', async () => {
      const model = 'anthropic/claude-sonnet-5';
      await store.updateSettings({
        organizationId: a.organizationId,
        patch: { defaultModelPolicy: [model] },
        operationKey: 'postgres-retry-policy-allow-01',
        audit: noAudit,
      });
      const beforeRows = await database.sql<{ id: string }[]>`
        select id from agent_runs where organization_id = ${a.organizationId}
      `;
      const beforeIds = new Set(beforeRows.map((row) => row.id));
      const beforeAudit = audit.events.length;
      const beforeStarts = startCalls.length;
      const headers = {
        ...as(a.owner, a.organizationId),
        'idempotency-key': 'postgres-explicit-run-retry-01',
      };
      const payload = {
        mode: 'build',
        prompt: 'Recover PostgreSQL explicit intent',
        appType: 'mobile',
        model,
      } as const;

      try {
        failedStarts = 1;
        const first = await app.inject({
          method: 'POST',
          url: `/v1/projects/${a.projectIds[0] ?? ''}/runs`,
          headers,
          payload,
        });
        expect(first.statusCode, first.body).toBe(502);
        const [failedDispatch] = await database.sql<{
          status: string;
          plan_max_credits: string;
        }[]>`
          select status, plan_max_credits from agent_runs
          where organization_id = ${a.organizationId}
          order by started_at desc limit 1
        `;
        expect(failedDispatch).toEqual({
          status: 'dispatch_failed',
          plan_max_credits: '1000.0000',
        });

        const canonicalBody =
          '{"appType":"mobile","mode":"build","model":"anthropic/claude-sonnet-5","prompt":"Recover PostgreSQL explicit intent"}';
        const rawFingerprint = createHash('sha256')
          .update(`POST\n/v1/projects/${a.projectIds[0] ?? ''}/runs\n${canonicalBody}`)
          .digest('hex');
        const expectedDurableFingerprint = createHmac('sha256', RUN_INTENT_HMAC_KEY)
          .update(rawFingerprint)
          .digest('hex');
        const [fingerprintRow] = await database.sql<{ request_fingerprint: string }[]>`
          select request_fingerprint from agent_runs
          where organization_id = ${a.organizationId}
            and request_fingerprint = ${expectedDurableFingerprint}
        `;
        expect(fingerprintRow?.request_fingerprint).not.toBe(rawFingerprint);
        expect(fingerprintRow?.request_fingerprint).toBe(expectedDurableFingerprint);

        const changed = await app.inject({
          method: 'POST',
          url: `/v1/projects/${a.projectIds[0] ?? ''}/runs`,
          headers,
          payload: { ...payload, appType: 'web' },
        });
        expectRefusal(changed, 422, 'idempotency_conflict');

        const afterChangedRows = await database.sql<{ id: string }[]>`
          select id from agent_runs where organization_id = ${a.organizationId}
        `;
        expect(afterChangedRows.filter((row) => !beforeIds.has(row.id))).toHaveLength(1);
        expect(startCalls.slice(beforeStarts)).toHaveLength(1);

        await store.updateSettings({
          organizationId: a.organizationId,
          patch: { defaultModelPolicy: ['openai/gpt-5'] },
          operationKey: 'postgres-retry-policy-deny-01',
          audit: noAudit,
        });
        const retry = await app.inject({
          method: 'POST',
          url: `/v1/projects/${a.projectIds[0] ?? ''}/runs`,
          headers,
          payload,
        });
        expect(retry.statusCode, retry.body).toBe(201);
        const recovered = retry.json<{
          run: { id: string; appType: string; model: string | null };
        }>().run;
        expect(recovered).toMatchObject({ appType: 'mobile', model });
        const [readmitted] = await database.sql<{ status: string; plan_max_credits: string }[]>`
          select status, plan_max_credits from agent_runs where id = ${recovered.id}
        `;
        expect(readmitted).toEqual({ status: 'queued', plan_max_credits: '1000.0000' });

        const rows = await database.sql<{
          id: string;
          app_type: string;
          model: string | null;
        }[]>`
          select id, app_type, model
          from agent_runs
          where organization_id = ${a.organizationId}
        `;
        const createdRows = rows.filter((row) => !beforeIds.has(row.id));
        expect(createdRows).toEqual([
          { id: recovered.id, app_type: 'mobile', model },
        ]);

        const deniedNew = await app.inject({
          method: 'POST',
          url: `/v1/projects/${a.projectIds[0] ?? ''}/runs`,
          headers: {
            ...as(a.owner, a.organizationId),
            'idempotency-key': 'postgres-explicit-run-denied-new-01',
          },
          payload: {
            mode: 'build',
            prompt: 'Do not persist a newly denied PostgreSQL intent',
            appType: 'mobile',
            model,
          },
        });
        expectRefusal(deniedNew, 400, 'model_not_allowed');
        const rowsAfterDenial = await database.sql<{ id: string }[]>`
          select id from agent_runs where organization_id = ${a.organizationId}
        `;
        expect(rowsAfterDenial.filter((row) => !beforeIds.has(row.id))).toEqual([
          { id: recovered.id },
        ]);
        expect(
          audit.events
            .slice(beforeAudit)
            .filter((event) => event.action === 'run.created' && event.targetId === recovered.id),
        ).toHaveLength(1);
        expect(startCalls.slice(beforeStarts)).toEqual([
          expect.objectContaining({ runId: recovered.id, appType: 'mobile', model }),
          expect.objectContaining({ runId: recovered.id, appType: 'mobile', model }),
        ]);

        const read = await app.inject({
          method: 'GET',
          url: `/v1/runs/${recovered.id}`,
          headers: as(a.owner, a.organizationId),
        });
        expect(read.statusCode, read.body).toBe(200);
        expect(read.json<{ run: { appType: string; model: string | null } }>().run).toMatchObject({
          appType: 'mobile',
          model,
        });
      } finally {
        failedStarts = 0;
        await database.sql`
          update organizations
          set settings_json = '{}'::jsonb
          where id = ${a.organizationId}
        `;
      }
    });

    it('settles authorized and denied new intents with one available PostgreSQL connection', async () => {
      const model = 'anthropic/claude-sonnet-5';
      await store.updateSettings({
        organizationId: a.organizationId,
        patch: { defaultModelPolicy: [model] },
        operationKey: 'postgres-one-connection-policy-allow-01',
        audit: noAudit,
      });
      const authorized = await withOneAvailableConnection(database, async () =>
        await app.inject({
          method: 'POST',
          url: `/v1/projects/${a.projectIds[0] ?? ''}/runs`,
          headers: {
            ...as(a.owner, a.organizationId),
            'idempotency-key': 'postgres-one-connection-authorized-01',
          },
          payload: {
            mode: 'build',
            prompt: 'Authorized with a bounded database pool',
            model,
          },
        }),
      );

      await store.updateSettings({
        organizationId: a.organizationId,
        patch: { defaultModelPolicy: ['openai/gpt-5'] },
        operationKey: 'postgres-one-connection-policy-deny-01',
        audit: noAudit,
      });
      const beforeDenied = await database.sql<{ id: string }[]>`
        select id from agent_runs where organization_id = ${a.organizationId}
      `;
      const denied = await withOneAvailableConnection(database, async () =>
        await app.inject({
          method: 'POST',
          url: `/v1/projects/${a.projectIds[0] ?? ''}/runs`,
          headers: {
            ...as(a.owner, a.organizationId),
            'idempotency-key': 'postgres-one-connection-denied-01',
          },
          payload: {
            mode: 'build',
            prompt: 'Denied without stranding the insert transaction',
            model,
          },
        }),
      );
      const afterDenied = await database.sql<{ id: string }[]>`
        select id from agent_runs where organization_id = ${a.organizationId}
      `;

      expect({
        authorizedTimedOut: authorized.timedOut,
        authorizedStatus: authorized.value.statusCode,
        deniedTimedOut: denied.timedOut,
        deniedStatus: denied.value.statusCode,
        deniedCode: errorOf(denied.value),
      }).toEqual({
        authorizedTimedOut: false,
        authorizedStatus: 201,
        deniedTimedOut: false,
        deniedStatus: 400,
        deniedCode: 'model_not_allowed',
      });
      expect(afterDenied).toEqual(beforeDenied);
    });

    it('shares one exact concurrent create contract between memory and PostgreSQL', async () => {
      const postgres = createTenantDbFactory(database.db)(a.organizationId).runs;
      const memoryData = new InMemoryTenantData();
      const memory = memoryData.factory(a.organizationId).runs;
      for (const backend of [
        {
          name: 'memory',
          repository: memory,
          rows: (id: string) =>
            Promise.resolve(
              memoryData.runs.filter((row) => row.id === id).map((row) => ({ id: row.id })),
            ),
        },
        {
          name: 'postgres',
          repository: postgres,
          rows: async (id: string) =>
            await database.sql<{ id: string }[]>`
              select id from agent_runs
              where organization_id = ${a.organizationId} and id = ${id}
            `,
        },
      ]) {
        const id = newId('run');
        const evidence = await exerciseConcurrentRunCreates(
          backend.repository,
          {
            id,
            workflowId: id,
            projectId: a.projectIds[0] ?? '',
            newConversationId: newId('conv'),
            conversationTitle: 'Concurrent run create',
            contextArtifactId: newId('art'),
            branchId: null,
            mode: 'build',
            appType: 'web',
            model: null,
            budget: null,
            accounting: RUN_ACCOUNTING,
            planMaxCredits: RUN_PLAN_MAX_CREDITS,
            startedBy: a.owner.userId,
            now: EVENT_TIME,
          },
          ['a'.repeat(64), 'a'.repeat(64)],
          async () => await backend.rows(id),
        );
        expect(evidence, backend.name).toMatchObject({
          outcomes: ['created', 'recovered'],
          authorizations: 1,
          audits: 1,
        });
        expect(evidence.rows, backend.name).toEqual([{ id }]);
      }
    });

    it('shares one conflicting concurrent create contract between memory and PostgreSQL', async () => {
      const postgres = createTenantDbFactory(database.db)(a.organizationId).runs;
      const memoryData = new InMemoryTenantData();
      const memory = memoryData.factory(a.organizationId).runs;
      for (const backend of [
        {
          name: 'memory',
          repository: memory,
          rows: (id: string) =>
            Promise.resolve(
              memoryData.runs.filter((row) => row.id === id).map((row) => ({ id: row.id })),
            ),
        },
        {
          name: 'postgres',
          repository: postgres,
          rows: async (id: string) =>
            await database.sql<{ id: string }[]>`
              select id from agent_runs
              where organization_id = ${a.organizationId} and id = ${id}
            `,
        },
      ]) {
        const id = newId('run');
        const evidence = await exerciseConcurrentRunCreates(
          backend.repository,
          {
            id,
            workflowId: id,
            projectId: a.projectIds[0] ?? '',
            newConversationId: newId('conv'),
            conversationTitle: 'Conflicting run create',
            contextArtifactId: newId('art'),
            branchId: null,
            mode: 'build',
            appType: 'mobile',
            model: null,
            budget: null,
            accounting: RUN_ACCOUNTING,
            planMaxCredits: RUN_PLAN_MAX_CREDITS,
            startedBy: a.owner.userId,
            now: EVENT_TIME,
          },
          ['b'.repeat(64), 'c'.repeat(64)],
          async () => await backend.rows(id),
        );
        expect(evidence, backend.name).toMatchObject({
          outcomes: ['conflict', 'created'],
          authorizations: 1,
          audits: 1,
        });
        expect(evidence.rows, backend.name).toEqual([{ id }]);
      }
    });

    it('leases exhaustion polling to one replica and persists episode recovery identity', async () => {
      let currentTime = new Date('2026-08-11T12:00:00.000Z');
      const now = () => new Date(currentTime);
      const first = createDatabaseCreditExhaustionStore({
        database: database.db,
        owner: 'credit-producer-a',
        now,
        leaseMs: 100,
      });
      const second = createDatabaseCreditExhaustionStore({
        database: database.db,
        owner: 'credit-producer-b',
        now,
        leaseMs: 100,
      });

      const firstClaim = await first.claimOrganizations(10);
      expect(firstClaim).toMatchObject({ acquired: true });
      if (!firstClaim.acquired) throw new Error('first exhaustion lease was not acquired');
      await expect(second.claimOrganizations(10)).resolves.toEqual({
        acquired: false,
        organizationIds: [],
      });
      const episode = await first.getOrOpenEpisode(firstClaim.leaseToken, a.organizationId);
      await expect(first.getOrOpenEpisode(firstClaim.leaseToken, a.organizationId)).resolves.toEqual(episode);
      const active = await first.listActiveRuns(firstClaim.leaseToken, a.organizationId, null, 100);
      expect(active.length).toBeGreaterThan(0);
      expect(active.every((run) => run.temporalWorkflowId.length > 0)).toBe(true);
      await expect(first.listActiveRuns(firstClaim.leaseToken, a.organizationId, active.at(-1)?.runId ?? null, 100))
        .resolves.toHaveLength(active.length);
      await first.closeEpisode(firstClaim.leaseToken, a.organizationId);
      const reexhausted = await first.getOrOpenEpisode(firstClaim.leaseToken, a.organizationId);
      expect(reexhausted.operationKey).not.toBe(episode.operationKey);

      currentTime = new Date(currentTime.getTime() + 101);
      const takeover = await second.claimOrganizations(10);
      expect(takeover).toMatchObject({ acquired: true });
      if (!takeover.acquired) throw new Error('expired exhaustion lease was not acquired');
      expect(takeover.leaseToken).not.toBe(firstClaim.leaseToken);
      await expect(
        first.advanceEpisode(firstClaim.leaseToken, reexhausted.operationKey, active[0]?.runId ?? ''),
      ).rejects.toThrow('lease ownership was lost');
      await expect(
        second.listActiveRuns(takeover.leaseToken, a.organizationId, null, 1),
      ).resolves.toHaveLength(1);
    });
  });

  describe('a session in A, reading B by id', () => {
    it('does not find B’s project', async () => {
      for (const projectId of b.projectIds) {
        const response = await app.inject({
          method: 'GET',
          url: `/v1/projects/${projectId}`,
          headers: as(a.owner, a.organizationId),
        });
        expectRefusal(response, 404, 'project_not_found');
      }
    });

    it('does not find B’s run', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/v1/runs/${b.runIds[0] ?? ''}`,
        headers: as(a.owner, a.organizationId),
      });
      expectRefusal(response, 404, 'run_not_found');
    });

    it('does not find the events of B’s run', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/v1/runs/${b.runIds[0] ?? ''}/events`,
        headers: as(a.owner, a.organizationId),
      });
      expectRefusal(response, 404, 'run_not_found');
    });

    it('does not find the execution contract of B’s project', async () => {
      // A contract carries the commands that build and test a project — the
      // shape of somebody else's codebase. It is seeded for both tenants, so
      // this 404 is a refusal rather than an absence.
      const response = await app.inject({
        method: 'GET',
        url: `/v1/projects/${b.projectIds[0] ?? ''}/contract`,
        headers: as(a.owner, a.organizationId),
      });
      expectRefusal(response, 404, 'project_not_found');
    });

    it('does not list the secrets of B’s project', async () => {
      // Names alone are information about how somebody else's project is
      // deployed (PRD §18.12), which is why this is a refusal and not a
      // filtered list.
      const response = await app.inject({
        method: 'GET',
        url: `/v1/projects/${b.projectIds[0] ?? ''}/secrets`,
        headers: as(a.owner, a.organizationId),
      });
      expectRefusal(response, 404, 'project_not_found');
      expect(response.body).not.toContain(SECRET_VALUE);
    });

    it('cannot write, rotate or delete a secret in B’s project', async () => {
      const projectId = b.projectIds[0] ?? '';
      const secretId = b.secretIds[0] ?? '';

      const written = await app.inject({
        method: 'POST',
        url: `/v1/projects/${projectId}/secrets`,
        headers: as(a.owner, a.organizationId),
        payload: { name: 'PLANTED', value: 'planted-by-a' },
      });
      expectRefusal(written, 404, 'project_not_found');

      const rotated = await app.inject({
        method: 'POST',
        url: `/v1/projects/${projectId}/secrets/${secretId}/rotate`,
        headers: as(a.owner, a.organizationId),
        payload: { value: 'rotated-by-a' },
      });
      expectRefusal(rotated, 404, 'secret_not_found');

      const deleted = await app.inject({
        method: 'DELETE',
        url: `/v1/projects/${projectId}/secrets/${secretId}`,
        headers: as(a.owner, a.organizationId),
      });
      expectRefusal(deleted, 404, 'secret_not_found');

      // Confirmed in the tables rather than in the answers: nothing planted
      // under either tenant, and B's secret still holds B's value.
      const planted = await database.sql<{ id: string }[]>`
        select id from secret_metadata where name = 'PLANTED'
      `;
      expect(planted).toEqual([]);
      const rows = await database.sql<{ organization_id: string; rotated_at: Date | null }[]>`
        select organization_id, rotated_at from secret_metadata where id = ${secretId}
      `;
      expect(rows[0]?.organization_id).toBe(b.organizationId);
      expect(rows[0]?.rotated_at).toBe(null);
      const vault = await database.sql<{ secret_id: string }[]>`
        select secret_id from secret_ciphertexts where secret_id = ${secretId}
      `;
      expect(vault).toHaveLength(1);
    });

    it('cannot decrypt B’s secret by naming its own organization', async () => {
      // The internal route has no session to scope it, so the organization is a
      // field of the body — which makes "can a caller point it at the wrong
      // one" the question this asserts. The handle is bound to the organization
      // named, so B's secret is simply not in it.
      const before = audit.events.length;
      const response = await app.inject({
        method: 'POST',
        url: '/internal/secrets/decrypt',
        headers: { [SERVICE_TOKEN_HEADER]: await serviceToken() },
        payload: {
          organizationId: a.organizationId,
          secretId: b.secretIds[0] ?? '',
          reason: 'reaching across a tenant boundary',
        },
      });

      expectRefusal(response, 404, 'secret_not_found');
      expect(response.body).not.toContain(SECRET_VALUE);
      expect(audit.events).toHaveLength(before);
    });

    it('cannot edit B’s project', async () => {
      // The write half of the cross-tenant attack on CP-6's own surface: A's
      // Owner — who is refused by no role check — naming B's project in the
      // path and A's organization in the header.
      const projectId = b.projectIds[0] ?? '';
      const response = await app.inject({
        method: 'PATCH',
        url: `/v1/projects/${projectId}`,
        headers: as(a.owner, a.organizationId),
        payload: { name: 'Mine Now', slug: 'mine-now', archived: true },
      });
      expectRefusal(response, 404, 'project_not_found');

      // Confirmed in the table rather than in the answer: B's project is
      // untouched, and no row was planted under A either.
      const [row] = await database.sql<{ name: string; archived_at: Date | null }[]>`
        select name, archived_at from projects where id = ${projectId}
      `;
      expect(row?.name).toBe('beta alpha');
      expect(row?.archived_at).toBe(null);
      const planted = await database.sql<{ id: string }[]>`
        select id from projects where slug = 'mine-now'
      `;
      expect(planted).toEqual([]);
    });

    it('cannot request a scan of B’s project', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/v1/projects/${b.projectIds[0] ?? ''}/scan`,
        headers: as(a.owner, a.organizationId),
      });
      expectRefusal(response, 404, 'project_not_found');
    });

    it('does not find the runs of B’s project', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/v1/projects/${b.projectIds[0] ?? ''}/runs`,
        headers: as(a.owner, a.organizationId),
      });
      expectRefusal(response, 404, 'project_not_found');
    });

    it('does not use B’s model policy to authorize A and still hides B’s project', async () => {
      const model = 'openai/gpt-5';
      await store.updateSettings({
        organizationId: a.organizationId,
        patch: { defaultModelPolicy: ['anthropic/claude-sonnet-5'] },
        operationKey: 'isolation-model-policy-a-01',
        audit: noAudit,
      });
      await store.updateSettings({
        organizationId: b.organizationId,
        patch: { defaultModelPolicy: { allowedModels: [model] } },
        operationKey: 'isolation-model-policy-b-01',
        audit: noAudit,
      });

      try {
        const denied = await app.inject({
          method: 'POST',
          url: `/v1/projects/${a.projectIds[0] ?? ''}/runs`,
          headers: {
            ...as(a.owner, a.organizationId),
            'idempotency-key': 'isolation-model-policy-denied-01',
          },
          payload: { mode: 'build', prompt: 'Do not borrow B policy', model },
        });
        expectRefusal(denied, 400, 'model_not_allowed');

        const foreign = await app.inject({
          method: 'POST',
          url: `/v1/projects/${b.projectIds[0] ?? ''}/runs`,
          headers: {
            ...as(a.owner, a.organizationId),
            'idempotency-key': 'isolation-model-policy-foreign-01',
          },
          payload: { mode: 'build', prompt: 'Do not reveal B project', model },
        });
        expectRefusal(foreign, 404, 'project_not_found');

        const allowed = await app.inject({
          method: 'POST',
          url: `/v1/projects/${b.projectIds[0] ?? ''}/runs`,
          headers: {
            ...as(b.owner, b.organizationId),
            'idempotency-key': 'isolation-model-policy-allowed-01',
          },
          payload: {
            mode: 'build',
            prompt: 'Use B policy for B project',
            appType: 'mobile',
            model,
          },
        });
        expect(allowed.statusCode, allowed.body).toBe(201);
        expect(
          allowed.json<{
            run: { organizationId: string; appType: string; model: string | null };
          }>().run,
        ).toMatchObject({ organizationId: b.organizationId, appType: 'mobile', model });
      } finally {
        await database.sql`
          update organizations
          set settings_json = '{}'::jsonb
          where id in (${a.organizationId}, ${b.organizationId})
        `;
      }
    });

    it('does not find B’s organization', async () => {
      const response = await app.inject({
        method: 'PATCH',
        url: `/v1/organizations/${b.organizationId}`,
        headers: a.owner.headers,
        payload: { name: 'Mine Now' },
      });
      expectRefusal(response, 404, 'organization_not_found');
    });

    it('does not read B’s audit trail or settings, or patch B’s settings', async () => {
      const audit = await app.inject({
        method: 'GET',
        url: `/v1/organizations/${b.organizationId}/audit-events`,
        headers: as(a.owner, a.organizationId),
      });
      expectRefusal(audit, 404, 'organization_not_found');

      const settings = await app.inject({
        method: 'GET',
        url: `/v1/organizations/${b.organizationId}/settings`,
        headers: as(a.owner, a.organizationId),
      });
      expectRefusal(settings, 404, 'organization_not_found');

      const patched = await app.inject({
        method: 'PATCH',
        url: `/v1/organizations/${b.organizationId}/settings`,
        headers: {
          ...as(a.owner, a.organizationId),
          'idempotency-key': 'isolation-settings-denied-01',
        },
        payload: { builderCanDeploy: true },
      });
      expectRefusal(patched, 404, 'organization_not_found');
      expect(await store.getSettings(b.organizationId)).toEqual({ builderCanDeploy: false });
    });

    it('cannot invite anyone into B', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/v1/organizations/${b.organizationId}/invites`,
        headers: a.owner.headers,
        payload: { email: 'intruder@acme.test', role: 'owner' },
      });
      expectRefusal(response, 404, 'organization_not_found');
    });

    it('cannot change or remove a member of B', async () => {
      const patched = await app.inject({
        method: 'PATCH',
        url: `/v1/organizations/${b.organizationId}/members/${b.viewer.userId}`,
        headers: a.owner.headers,
        payload: { role: 'owner' },
      });
      expectRefusal(patched, 404, 'organization_not_found');

      const deleted = await app.inject({
        method: 'DELETE',
        url: `/v1/organizations/${b.organizationId}/members/${b.owner.userId}`,
        headers: a.owner.headers,
      });
      expectRefusal(deleted, 404, 'organization_not_found');

      // And B is untouched by either attempt.
      expect(await store.membership(b.organizationId, b.viewer.userId)).toMatchObject({
        role: 'viewer',
        status: 'active',
      });
      expect(await store.membership(b.organizationId, b.owner.userId)).toMatchObject({
        role: 'owner',
        status: 'active',
      });
    });
  });

  describe('list endpoints', () => {
    it('never carry a project of the other tenant', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/v1/projects',
        headers: as(a.viewer, a.organizationId),
      });
      expectOnlyTenantRows(response, a, a.projectIds);
      const ids = rowsOf(response).map((row) => row.id);
      expect(ids.filter((id) => b.projectIds.includes(id))).toEqual([]);
    });

    it('never carry a run of the other tenant', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/v1/projects/${a.projectIds[0] ?? ''}/runs`,
        headers: as(a.viewer, a.organizationId),
      });
      expectOnlyTenantRows(response, a, [a.runIds[0] ?? '']);
      const ids = rowsOf(response).map((row) => row.id);
      expect(ids.filter((id) => b.runIds.includes(id))).toEqual([]);
    });

    it('never carries an event of the other tenant', async () => {
      const rows = await streamRows(a.viewer, a.organizationId, a.runIds[0] ?? '');
      const ids = rows.map((row) => row.id);
      expect(ids).toEqual(expect.arrayContaining(a.eventIds.slice(0, 2)));
      for (const row of rows) expect(row.organizationId).toBe(a.organizationId);
      expect(ids.filter((id) => b.eventIds.includes(id))).toEqual([]);
    });

    it('never carry an organization the caller is not in', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/v1/organizations',
        headers: a.owner.headers,
      });

      expect(response.statusCode, response.body).toBe(200);
      const ids = response
        .json<{ items: { organization: { id: string } }[] }>()
        .items.map((item) => item.organization.id);
      expect(ids).toEqual([a.organizationId]);
    });

    it('never carry an organization the caller was only invited to', async () => {
      // The membership list has to agree with the tenant plugin, which admits
      // `active` and nothing else. While it said "not removed" instead, this
      // person was shown an organization every other route then denied them
      // (plan 02 CP-4 review).
      const response = await app.inject({
        method: 'GET',
        url: '/v1/organizations',
        headers: a.pending.headers,
      });

      expect(response.statusCode, response.body).toBe(200);
      expect(response.json<{ items: unknown[] }>().items).toEqual([]);
    });
  });

  describe('the x-organization-id header', () => {
    it('does not admit a caller to an organization they are not in', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/v1/projects',
        headers: as(a.owner, b.organizationId),
      });
      expectRefusal(response, 404, 'organization_not_found');
    });

    it('answers the same for an organization that never existed', async () => {
      // Indistinguishable on purpose: a different answer here would be a probe
      // for which organization ids are real.
      const response = await app.inject({
        method: 'GET',
        url: '/v1/projects',
        headers: as(a.owner, newId('org')),
      });
      expectRefusal(response, 404, 'organization_not_found');
    });

    it('does not admit a caller whose membership is only invited', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/v1/projects',
        headers: as(a.pending, a.organizationId),
      });
      expectRefusal(response, 404, 'organization_not_found');
    });

    it('does not admit a removed member', async () => {
      const removed = await signIn('removed@acme.test');
      const now = new Date();
      await store.addMember({
        organizationId: a.organizationId,
        userId: removed.userId,
        role: 'builder',
        now,
        audit: noAudit,
      });
      expect(await store.removeMember(a.organizationId, removed.userId, noAudit)).toBe('updated');

      const response = await app.inject({
        method: 'GET',
        url: '/v1/projects',
        headers: as(removed, a.organizationId),
      });
      expectRefusal(response, 404, 'organization_not_found');
    });

    it('is required on a tenant-scoped route that has no organization in its path', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/v1/projects',
        headers: a.owner.headers,
      });
      expectRefusal(response, 400, 'organization_required');
    });

    it('cannot file a new row under another tenant', async () => {
      // The write half of the same attack, and the one that was untested: every
      // read above refuses to *return* B's rows, and this refuses to *create*
      // one there. A's owner, B named in the header, a project that must never
      // exist.
      const response = await app.inject({
        method: 'POST',
        url: '/v1/projects',
        headers: as(a.owner, b.organizationId),
        payload: { name: 'Planted In Beta', slug: 'planted-in-beta' },
      });
      expectRefusal(response, 404, 'organization_not_found');

      // Confirmed in the table rather than in the answer: nothing was written
      // under either organization.
      const rows = await database.sql<{ id: string }[]>`
        select id from projects where slug = 'planted-in-beta'
      `;
      expect(rows).toEqual([]);
    });

    it('cannot override the organization that owns a path resource', async () => {
      // A's owner, A's own project in the path, B named in the header. There is
      // no reading of this request that should return a row.
      const response = await app.inject({
        method: 'GET',
        url: `/v1/projects/${a.projectIds[0] ?? ''}`,
        headers: as(a.owner, b.organizationId),
      });
      expectRefusal(response, 404, 'organization_not_found');
    });

    it('cannot disagree with an organization in the path', async () => {
      for (const [path, header] of [
        [a.organizationId, b.organizationId],
        [b.organizationId, a.organizationId],
      ]) {
        const response = await app.inject({
          method: 'PATCH',
          url: `/v1/organizations/${path ?? ''}`,
          headers: as(a.owner, header),
          payload: { name: 'Confused' },
        });
        expectRefusal(response, 404, 'organization_not_found');
      }
      // A's name is exactly as it was seeded — no half-applied write.
      expect((await store.findById(a.organizationId))?.name).toBe('acme');
    });

    it('selects between the organizations a member of both belongs to', async () => {
      const inA = await app.inject({
        method: 'GET',
        url: '/v1/projects',
        headers: as(bridge, a.organizationId),
      });
      expectOnlyTenantRows(inA, a, a.projectIds);

      const inB = await app.inject({
        method: 'GET',
        url: '/v1/projects',
        headers: as(bridge, b.organizationId),
      });
      expectOnlyTenantRows(inB, b, b.projectIds);

      // Roles are per organization, not per person: a Viewer in A is still a
      // Viewer there however senior they are in B.
      const denied = await app.inject({
        method: 'POST',
        url: '/v1/projects',
        headers: as(bridge, a.organizationId),
        payload: { name: 'Bridge Project' },
      });
      expectRefusal(denied, 403, 'permission_denied');
    });
  });

  describe('the PRD §22.2 matrix', () => {
    it('refuses a Viewer’s mutation', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/projects',
        headers: as(a.viewer, a.organizationId),
        payload: { name: 'Viewer Project' },
      });

      expectRefusal(response, 403, 'permission_denied');
      expect(ApiErrorSchema.parse(response.json()).error.details).toEqual({
        action: 'create_project',
      });
      // A refusal that still wrote the row would be worse than no check at all.
      const rows = await database.sql<{ id: string }[]>`
        select id from projects where name = 'Viewer Project'
      `;
      expect(rows).toEqual([]);
    });

    it('refuses a Viewer’s edit of a project they can read', async () => {
      const projectId = a.projectIds[0] ?? '';
      const response = await app.inject({
        method: 'PATCH',
        url: `/v1/projects/${projectId}`,
        headers: as(a.viewer, a.organizationId),
        payload: { name: 'Viewer Renamed' },
      });

      expectRefusal(response, 403, 'permission_denied');
      expect(ApiErrorSchema.parse(response.json()).error.details).toEqual({ action: 'edit_code' });
      const [row] = await database.sql<{ name: string }[]>`
        select name from projects where id = ${projectId}
      `;
      expect(row?.name).toBe('acme alpha');
    });

    it('refuses a Viewer the secret metadata of a project they can read', async () => {
      // PRD §22.2 grants a Viewer `view_project` and denies them
      // `view_secret_metadata` — the one capability where the two diverge.
      const projectId = a.projectIds[0] ?? '';
      const readable = await app.inject({
        method: 'GET',
        url: `/v1/projects/${projectId}`,
        headers: as(a.viewer, a.organizationId),
      });
      expect(readable.statusCode, readable.body).toBe(200);

      const response = await app.inject({
        method: 'GET',
        url: `/v1/projects/${projectId}/secrets`,
        headers: as(a.viewer, a.organizationId),
      });
      expectRefusal(response, 403, 'permission_denied');
      expect(ApiErrorSchema.parse(response.json()).error.details).toEqual({
        action: 'view_secret_metadata',
      });
    });

    it('refuses a Builder on an Owner-only route', async () => {
      const response = await app.inject({
        method: 'PATCH',
        url: `/v1/organizations/${a.organizationId}`,
        headers: a.builder.headers,
        payload: { name: 'Builders R Us' },
      });

      expectRefusal(response, 403, 'permission_denied');
      expect(ApiErrorSchema.parse(response.json()).error.details).toEqual({
        action: 'manage_organization',
      });
      expect((await store.findById(a.organizationId))?.name).toBe('acme');
    });

    it('refuses a Builder’s invite', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/v1/organizations/${a.organizationId}/invites`,
        headers: a.builder.headers,
        payload: { email: 'someone@acme.test', role: 'owner' },
      });
      expectRefusal(response, 403, 'permission_denied');
    });
  });

  describe('a session with no memberships', () => {
    it('is asked for an organization rather than given one', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/v1/projects',
        headers: nomad.headers,
      });
      expectRefusal(response, 400, 'organization_required');
    });

    it('finds no organization it names', async () => {
      for (const organizationId of [a.organizationId, b.organizationId, newId('org')]) {
        const response = await app.inject({
          method: 'GET',
          url: '/v1/projects',
          headers: as(nomad, organizationId),
        });
        expectRefusal(response, 404, 'organization_not_found');
      }
    });

    it('finds no project, run or organization by id', async () => {
      const project = await app.inject({
        method: 'GET',
        url: `/v1/projects/${a.projectIds[0] ?? ''}`,
        headers: as(nomad, a.organizationId),
      });
      expectRefusal(project, 404, 'organization_not_found');

      const run = await app.inject({
        method: 'GET',
        url: `/v1/runs/${a.runIds[0] ?? ''}`,
        headers: as(nomad, a.organizationId),
      });
      expectRefusal(run, 404, 'organization_not_found');

      const organization = await app.inject({
        method: 'PATCH',
        url: `/v1/organizations/${a.organizationId}`,
        headers: nomad.headers,
        payload: { name: 'Nobody’s' },
      });
      expectRefusal(organization, 404, 'organization_not_found');
    });

    it('gets its own empty membership list, which is not a leak', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/v1/organizations',
        headers: nomad.headers,
      });

      expect(response.statusCode, response.body).toBe(200);
      expect(response.json<{ items: unknown[]; nextCursor: null }>()).toEqual({
        items: [],
        nextCursor: null,
      });
    });
  });

  describe('negative control — the same requests, correctly addressed', () => {
    /**
     * Without this block the suite could pass by refusing everything, which is
     * the failure mode that makes an isolation suite worthless. Every refusal
     * asserted above has its mirror image here.
     */

    it('reads A’s own project, run and events', async () => {
      const projectId = a.projectIds[0] ?? '';
      const runId = a.runIds[0] ?? '';

      const project = await app.inject({
        method: 'GET',
        url: `/v1/projects/${projectId}`,
        headers: as(a.viewer, a.organizationId),
      });
      expect(project.statusCode, project.body).toBe(200);
      expect(project.json<{ project: Row }>().project).toMatchObject({
        id: projectId,
        organizationId: a.organizationId,
      });

      const run = await app.inject({
        method: 'GET',
        url: `/v1/runs/${runId}`,
        headers: as(a.viewer, a.organizationId),
      });
      expect(run.statusCode, run.body).toBe(200);
      expect(run.json<{ run: Row }>().run).toMatchObject({
        id: runId,
        organizationId: a.organizationId,
      });

      const events = await streamRows(a.viewer, a.organizationId, runId);
      expect(events.map((event) => event.id)).toEqual(
        expect.arrayContaining(a.eventIds.slice(0, 2)),
      );
      for (const event of events) expect(event.organizationId).toBe(a.organizationId);
      negativeControlsRun += 1;
    });

    it('lets B read B’s own rows, by the same routes that refused A', async () => {
      for (const projectId of b.projectIds) {
        const response = await app.inject({
          method: 'GET',
          url: `/v1/projects/${projectId}`,
          headers: as(b.builder, b.organizationId),
        });
        expect(response.statusCode, response.body).toBe(200);
        expect(response.json<{ project: Row }>().project.organizationId).toBe(b.organizationId);
      }

      const run = await app.inject({
        method: 'GET',
        url: `/v1/runs/${b.runIds[0] ?? ''}`,
        headers: as(b.builder, b.organizationId),
      });
      expect(run.statusCode, run.body).toBe(200);

      const runs = await app.inject({
        method: 'GET',
        url: `/v1/projects/${b.projectIds[0] ?? ''}/runs`,
        headers: as(b.builder, b.organizationId),
      });
      expectOnlyTenantRows(runs, b, [b.runIds[0] ?? '']);
      negativeControlsRun += 1;
    });

    it('lets a Builder create a project, in their own organization only', async () => {
      // Smuggling B's id in the body is now *refused* rather than ignored: the
      // create schema is `.strict()` (plan 02 CP-6 review), so a client that
      // believes it is choosing the organization is told it is not, instead of
      // being quietly overruled. Both halves are asserted — the refusal, and
      // then the plain create that must still succeed.
      const smuggled = await app.inject({
        method: 'POST',
        url: '/v1/projects',
        headers: as(a.builder, a.organizationId),
        payload: { name: 'Smuggled Project', organizationId: b.organizationId },
      });
      expectRefusal(smuggled, 400, 'validation_failed');
      expect(await database.sql`select id from projects where name = 'Smuggled Project'`).toEqual(
        [],
      );

      const response = await app.inject({
        method: 'POST',
        url: '/v1/projects',
        headers: as(a.builder, a.organizationId),
        payload: { name: 'Builder Project' },
      });

      expect(response.statusCode, response.body).toBe(201);
      const created = response.json<{ project: Row }>().project;
      expect(created.organizationId).toBe(a.organizationId);

      // Confirmed in the table, not in the response: the row is what another
      // tenant would or would not be able to read.
      const [row] = await database.sql<{ organization_id: string }[]>`
        select organization_id from projects where id = ${created.id}
      `;
      expect(row?.organization_id).toBe(a.organizationId);

      // And B cannot see it.
      const fromB = await app.inject({
        method: 'GET',
        url: `/v1/projects/${created.id}`,
        headers: as(b.owner, b.organizationId),
      });
      expectRefusal(fromB, 404, 'project_not_found');
      negativeControlsRun += 1;
    });

    it('lets B edit, scan and read the contract of B’s own project', async () => {
      // The mirror of the three CP-6 refusals above. Without this, "PATCH,
      // contract and scan are isolated" would be satisfied by a service where
      // all three are broken for everybody.
      const projectId = b.projectIds[1] ?? '';

      const patched = await app.inject({
        method: 'PATCH',
        url: `/v1/projects/${projectId}`,
        headers: as(b.builder, b.organizationId),
        payload: { name: 'Beta Beta Renamed' },
      });
      expect(patched.statusCode, patched.body).toBe(200);
      expect(patched.json<{ project: { name: string } }>().project.name).toBe('Beta Beta Renamed');

      const contract = await app.inject({
        method: 'GET',
        url: `/v1/projects/${projectId}/contract`,
        headers: as(b.viewer, b.organizationId),
      });
      expect(contract.statusCode, contract.body).toBe(200);
      expect(
        contract.json<{ contract: { projectId: string; organizationId: string } }>().contract,
      ).toMatchObject({ projectId, organizationId: b.organizationId });

      const scan = await app.inject({
        method: 'POST',
        url: `/v1/projects/${projectId}/scan`,
        headers: as(b.builder, b.organizationId),
      });
      expect(scan.statusCode, scan.body).toBe(202);
      expect(scan.json<{ scan: { projectId: string } }>().scan.projectId).toBe(projectId);

      negativeControlsRun += 1;
    });

    it('lets an Owner rename their own organization and invite into it', async () => {
      const renamed = await app.inject({
        method: 'PATCH',
        url: `/v1/organizations/${b.organizationId}`,
        headers: as(b.owner, b.organizationId),
        payload: { name: 'Beta Works' },
      });
      expect(renamed.statusCode, renamed.body).toBe(200);
      expect(renamed.json<{ organization: { name: string } }>().organization.name).toBe(
        'Beta Works',
      );

      const invited = await app.inject({
        method: 'POST',
        url: `/v1/organizations/${b.organizationId}/invites`,
        headers: as(b.owner, b.organizationId),
        payload: { email: 'newcomer@beta.test', role: 'viewer' },
      });
      expect(invited.statusCode, invited.body).toBe(201);
      negativeControlsRun += 1;
    });

    it('lets B read its own audit trail and settings without exposing either tenant', async () => {
      const audit = await app.inject({
        method: 'GET',
        url: `/v1/organizations/${b.organizationId}/audit-events`,
        headers: as(b.owner, b.organizationId),
      });
      expectOnlyTenantRows(audit, b, b.auditEventIds);
      expect(rowsOf(audit).map((row) => row.id)).not.toEqual(
        expect.arrayContaining(a.auditEventIds),
      );

      const policy = { providerOrder: ['anthropic'] };
      const patched = await app.inject({
        method: 'PATCH',
        url: `/v1/organizations/${b.organizationId}/settings`,
        headers: {
          ...as(b.owner, b.organizationId),
          'idempotency-key': 'isolation-settings-own-01',
        },
        payload: { defaultModelPolicy: policy },
      });
      expect(patched.statusCode, patched.body).toBe(200);
      expect(patched.json()).toEqual({
        settings: { builderCanDeploy: false, defaultModelPolicy: policy },
      });

      expect(await store.getSettings(a.organizationId)).toEqual({ builderCanDeploy: false });
      expect(await store.getSettings(b.organizationId)).toEqual({
        builderCanDeploy: false,
        defaultModelPolicy: policy,
      });
      negativeControlsRun += 1;
    });

    it('reads A’s own secret metadata — and never a value, on any route', async () => {
      const projectId = a.projectIds[0] ?? '';
      const secretId = a.secretIds[0] ?? '';

      const listed = await app.inject({
        method: 'GET',
        url: `/v1/projects/${projectId}/secrets`,
        headers: as(a.builder, a.organizationId),
      });
      expectOnlyTenantRows(listed, a, [secretId]);
      // The metadata is there; the value is not — and neither is the other
      // tenant's, which is what makes this a control rather than a smoke test.
      expect(listed.json<{ items: { name: string }[] }>().items[0]?.name).toBe('DATABASE_URL');
      expect(listed.body).not.toContain(SECRET_VALUE);

      // The one path that does produce a plaintext, correctly addressed: an
      // allowlisted service, the right organization, a reason — and exactly one
      // audit row for it.
      const before = audit.events.length;
      const decrypted = await app.inject({
        method: 'POST',
        url: '/internal/secrets/decrypt',
        headers: { [SERVICE_TOKEN_HEADER]: await serviceToken() },
        payload: {
          organizationId: a.organizationId,
          secretId,
          reason: 'negative control for the isolation suite',
        },
      });
      expect(decrypted.statusCode, decrypted.body).toBe(200);
      expect(decrypted.json<{ value: string }>().value).toBe(`acme-${SECRET_VALUE}`);

      const written = audit.events.slice(before);
      expect(written).toHaveLength(1);
      expect(written[0]).toMatchObject({
        action: 'secret.decrypted',
        actorType: 'service',
        actorId: SANDBOX,
        organizationId: a.organizationId,
        targetId: secretId,
      });

      // And the same route refuses the same request from a user session.
      const asUser = await app.inject({
        method: 'POST',
        url: '/internal/secrets/decrypt',
        headers: as(a.owner, a.organizationId),
        payload: {
          organizationId: a.organizationId,
          secretId,
          reason: 'a person asking for their own organization’s secret',
        },
      });
      expectRefusal(asUser, 401, 'service_unauthenticated');
      expect(asUser.body).not.toContain(SECRET_VALUE);
      negativeControlsRun += 1;
    });

    it('still requires a session for every one of these routes', async () => {
      for (const url of ['/v1/projects', `/v1/runs/${a.runIds[0] ?? ''}`]) {
        const response = await app.inject({
          method: 'GET',
          url,
          headers: { [ORGANIZATION_HEADER]: a.organizationId },
        });
        expectRefusal(response, 401, 'unauthenticated');
      }
      negativeControlsRun += 1;
    });

    it('still requires the CSRF header from a cookie-borne mutation', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/projects',
        headers: { cookie: a.owner.cookie, [ORGANIZATION_HEADER]: a.organizationId },
        payload: { name: 'Forged' },
      });
      expectRefusal(response, 403, 'csrf_required');
      negativeControlsRun += 1;
    });
  });

  /**
   * Last, and outside the block it is about, so that disabling that block
   * cannot disable this too.
   *
   * The negative controls are the only thing standing between this suite and a
   * service that passes it by refusing every request. A `describe.skip` on
   * them — added in a hurry, meant to be temporary — would leave the milestone
   * gate green and meaningless, and nothing in a test report distinguishes a
   * skipped block from an absent one. This counts them.
   */
  describe('the negative control', () => {
    it('actually ran', () => {
      expect(negativeControlsRun).toBe(NEGATIVE_CONTROLS);
    });
  });
});
