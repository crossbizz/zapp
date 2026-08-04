import type { AuthIdentity } from '../../src/auth/port.js';
import type { UserProfile, UserStore } from '../../src/auth/users.js';
import type { AuthConfig } from '../../src/auth/config.js';
import { buildApp, type AppInstance } from '../../src/app.js';
import { CSRF_COOKIE, CSRF_HEADER } from '../../src/auth/cookies.js';
import { createInMemoryTokenDenylist } from '../../src/auth/denylist.js';
import { createInMemoryDeviceStore } from '../../src/auth/device.js';
import type { ProxyTrust, RateLimitConfig } from '../../src/config/rate-limits.js';
import { createInMemoryInviteStore, type InviteStore } from '../../src/orgs/invites.js';
import { createInMemoryAuditSink, type InMemoryAuditSink } from '../../src/plugins/audit.js';
import {
  createInMemoryIdempotencyStore,
  type IdempotencyStore,
} from '../../src/plugins/idempotency.js';
import type { GitServicePort } from '../../src/git/port.js';
import type { ServiceTokenVerifier } from '../../src/internal/service-auth.js';
import { createInMemoryRateLimiter, type RateLimiter } from '../../src/plugins/rate-limit.js';
import { createEnvMasterKey, KEY_BYTES, type MasterKeyPort } from '../../src/secrets/crypto.js';
import type { TenantDbFactory } from '../../src/tenant/db.js';
import { FakeAuthPort } from './fake-auth-port.js';
import { FakeServiceTokens } from './fake-service-tokens.js';
import { InMemoryOrganizationStore } from './org-store.js';

/** 32 bytes of nothing, in the shape the config demands. Never a real key. */
export const TEST_SECRET = 'a'.repeat(64);
export const TEST_PREVIOUS_SECRET = 'b'.repeat(64);

/**
 * The vault's master key for tests: a fixed byte pattern, and the *shipping*
 * `createEnvMasterKey` around it rather than a stub.
 *
 * Which means every secrets suite exercises real AES-256-GCM — real nonces, real
 * tags, a real wrap and unwrap. A fake cipher would let a test pass while the
 * envelope was subtly wrong, and the envelope is the whole task.
 */
export const TEST_MASTER_KEY: MasterKeyPort = createEnvMasterKey({
  key: Buffer.alloc(KEY_BYTES, 0x2a),
  version: 1,
});

export const TEST_AUTH_CONFIG: AuthConfig = {
  sessionSecret: TEST_SECRET,
  appBaseUrl: 'https://app.zapp.test',
  apiBaseUrl: 'https://api.zapp.test',
};

/**
 * Limits high enough to be out of the way, because every request a suite makes
 * comes from one address and — for the auth class — the shipped ceiling of ten
 * a minute is four sign-ins.
 *
 * Deliberately explicit rather than a switch inside the plugin: a suite that
 * silently ran with rate limiting *off* would not be exercising the pipeline
 * the service ships, so the plugin is always registered and always consulted;
 * only the numbers move. `test/plugins.test.ts` both tightens them, for the
 * assertions that are about limiting, and pins the shipped file's own values.
 */
const OUT_OF_THE_WAY = { perMinute: 100_000, burst: 100_000 } as const;

export const TEST_RATE_LIMITS: RateLimitConfig = {
  auth: { ...OUT_OF_THE_WAY, scope: 'ip', whenUnavailable: 'deny' },
  device: { ...OUT_OF_THE_WAY, scope: 'ip', whenUnavailable: 'deny' },
  reads: { ...OUT_OF_THE_WAY, scope: 'organization', whenUnavailable: 'allow' },
  mutations: { ...OUT_OF_THE_WAY, scope: 'organization', whenUnavailable: 'allow' },
};

/** Trust nothing, like the shipped file — the suites that care set their own. */
export const TEST_PROXY_TRUST: ProxyTrust = { trustedHops: 0, trustedProxies: [] };

/** A `UserStore` with a Map behind it, so route tests need no database. */
export class InMemoryUserStore implements UserStore {
  readonly users = new Map<string, UserProfile['user']>();
  readonly memberships = new Map<string, UserProfile['memberships']>();
  /** Bumped on every upsert, so a test can tell "linked" from "created". */
  upsertCount = 0;

  upsertFromIdentity(identity: AuthIdentity): Promise<UserProfile['user']> {
    this.upsertCount += 1;
    const existing = [...this.users.values()].find((user) => user.email === identity.email);
    const user = {
      id: existing?.id ?? `user_${String(this.users.size + 1).padStart(26, '0')}`,
      email: identity.email,
      displayName: identity.displayName,
      avatarUrl: identity.avatarUrl ?? null,
    };
    this.users.set(user.id, user);
    return Promise.resolve(user);
  }

  profile(userId: string): Promise<UserProfile | undefined> {
    const user = this.users.get(userId);
    if (user === undefined) {
      return Promise.resolve(undefined);
    }
    return Promise.resolve({ user, memberships: this.memberships.get(userId) ?? [] });
  }
}

export interface Harness {
  readonly app: AppInstance;
  readonly port: FakeAuthPort;
  readonly users: InMemoryUserStore;
  readonly organizations: InMemoryOrganizationStore;
  /** The shipping in-memory implementation, not a double — CP-5 replaces it. */
  readonly invites: InviteStore;
  readonly audit: InMemoryAuditSink;
  /**
   * The service tokens `/internal/*` will accept. Empty until a test issues
   * one, so an internal route in a suite that never mentions services behaves
   * exactly as the deployed deny-all one does.
   */
  readonly serviceTokens: FakeServiceTokens;
  /** Test-controlled clock, so expiry is asserted rather than waited for. */
  advance: (milliseconds: number) => void;
  now: () => Date;
}

export interface HarnessOptions {
  readonly config?: Partial<AuthConfig>;
  readonly users?: InMemoryUserStore;
  readonly organizations?: InMemoryOrganizationStore;
  /** Tightens one or more classes; the rest stay out of the way. */
  readonly rateLimits?: Partial<RateLimitConfig>;
  /** For the suites that assert how far a forwarded address is believed. */
  readonly proxy?: ProxyTrust;
  /** For the suites that need a limiter which cannot answer. */
  readonly limiter?: RateLimiter;
  readonly idempotency?: IdempotencyStore;
  /**
   * Registers the tenant-scoped routes against a handle of the caller's
   * choosing. Absent by default — a unit harness has no database, and the
   * tenant surface has its own suite against a real one
   * (`test/integration/tenant-isolation.test.ts`).
   */
  readonly tenantDb?: TenantDbFactory;
  /**
   * Substitutes the git service the project-creation transaction calls. The
   * suites that assert the rollback bind one that refuses; everything else gets
   * the shipping record-only implementation.
   */
  readonly git?: GitServicePort;
  /**
   * Which services may call `/internal/secrets/decrypt`. Defaults to the
   * shipping list; the suite that proves an unallowlisted caller is refused
   * narrows it.
   */
  readonly decryptCallers?: readonly string[];
}

/**
 * A fully wired app whose only fakes are the identity provider, the user store,
 * the organization store and the clock — the session plugin, the routes, the
 * RBAC matrix, the denylist, the device store and the invite store are the
 * shipping implementations.
 */
export function buildHarness(options: HarnessOptions = {}): Harness {
  const port = new FakeAuthPort();
  const users = options.users ?? new InMemoryUserStore();
  const organizations = options.organizations ?? new InMemoryOrganizationStore();
  let offset = 0;
  const now = (): Date => new Date(Date.now() + offset);
  const invites = createInMemoryInviteStore(now);
  const audit = createInMemoryAuditSink();
  const serviceTokens: ServiceTokenVerifier & FakeServiceTokens = new FakeServiceTokens();

  const app = buildApp({
    logger: false,
    now,
    auth: {
      port,
      users,
      config: { ...TEST_AUTH_CONFIG, ...options.config },
      denylist: createInMemoryTokenDenylist(now),
      deviceStore: createInMemoryDeviceStore(now),
      now,
    },
    orgs: { organizations, invites, audit },
    ...(options.tenantDb === undefined
      ? {}
      : {
          tenant: {
            tenantDb: options.tenantDb,
            ...(options.git === undefined ? {} : { git: options.git }),
          },
          // Wired whenever the tenant surface is, so every route suite runs
          // against an app that has the vault registered — a secrets route that
          // only existed in the suite testing it would be a route the rest of
          // the pipeline was never exercised against.
          secrets: {
            masterKey: TEST_MASTER_KEY,
            serviceTokens,
            ...(options.decryptCallers === undefined
              ? {}
              : { decryptCallers: options.decryptCallers }),
          },
        }),
    limits: {
      config: { ...TEST_RATE_LIMITS, ...options.rateLimits },
      proxy: options.proxy ?? TEST_PROXY_TRUST,
      limiter: options.limiter ?? createInMemoryRateLimiter(now),
      idempotency: options.idempotency ?? createInMemoryIdempotencyStore(now),
    },
  });

  return {
    app,
    port,
    users,
    organizations,
    invites,
    audit,
    serviceTokens,
    now,
    advance: (milliseconds: number) => {
      offset += milliseconds;
    },
  };
}

/** A signed-in browser: the cookie jar it holds and the header its page sends. */
export interface TestSession {
  readonly userId: string;
  readonly email: string;
  /** The `Cookie` header alone — for the tests that send it *without* the CSRF header. */
  readonly cookie: string;
  readonly csrf: string;
  readonly headers: Record<string, string>;
}

/**
 * Drives the full login → callback handshake and returns what a browser would
 * then be sending. Route tests go through the real flow rather than minting a
 * token directly: a session a test manufactured is not the session the service
 * issues.
 */
export async function signIn(built: Harness, identity: AuthIdentity): Promise<TestSession> {
  const code = `auth-code-${identity.email}`;
  const start = await built.app.inject({ method: 'GET', url: '/v1/auth/login' });
  const state = new URL(start.headers.location as string).searchParams.get('state') ?? '';
  built.port.issueCode(code, identity);

  const callback = await built.app.inject({
    method: 'GET',
    url: `/v1/auth/callback?code=${code}&state=${encodeURIComponent(state)}`,
    headers: { cookie: cookieJar(cookiesOf(start.headers['set-cookie'])) },
  });

  const cookies = cookiesOf(callback.headers['set-cookie']);
  const user = [...built.users.users.values()].find((row) => row.email === identity.email);
  if (user === undefined) {
    throw new Error(`sign-in did not create a user for ${identity.email}`);
  }

  const cookie = cookieJar(cookies);
  const csrf = cookies.get(CSRF_COOKIE) ?? '';
  return {
    userId: user.id,
    email: user.email,
    cookie,
    csrf,
    headers: { cookie, [CSRF_HEADER]: csrf },
  };
}

/** The `Set-Cookie` values of a response, as a name → value map (attributes dropped). */
export function cookiesOf(setCookie: string | string[] | undefined): Map<string, string> {
  const raw = setCookie === undefined ? [] : Array.isArray(setCookie) ? setCookie : [setCookie];
  const cookies = new Map<string, string>();
  for (const header of raw) {
    const [pair] = header.split(';');
    const separator = pair?.indexOf('=') ?? -1;
    if (pair !== undefined && separator > 0) {
      cookies.set(pair.slice(0, separator), pair.slice(separator + 1));
    }
  }
  return cookies;
}

/** The raw `Set-Cookie` header for `name`, attributes included. */
export function cookieHeader(
  setCookie: string | string[] | undefined,
  name: string,
): string | undefined {
  const raw = setCookie === undefined ? [] : Array.isArray(setCookie) ? setCookie : [setCookie];
  return raw.find((header) => header.startsWith(`${name}=`));
}

/** Serializes a cookie jar back into a `Cookie` request header. */
export function cookieJar(cookies: Map<string, string>): string {
  return [...cookies].map(([name, value]) => `${name}=${value}`).join('; ');
}
