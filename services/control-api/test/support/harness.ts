import type { AuthIdentity } from '../../src/auth/port.js';
import type { UserProfile, UserStore } from '../../src/auth/users.js';
import type { AuthConfig } from '../../src/auth/config.js';
import { buildApp, type AppInstance } from '../../src/app.js';
import { createInMemoryTokenDenylist } from '../../src/auth/denylist.js';
import { createInMemoryDeviceStore } from '../../src/auth/device.js';
import { FakeAuthPort } from './fake-auth-port.js';

/** 32 bytes of nothing, in the shape the config demands. Never a real key. */
export const TEST_SECRET = 'a'.repeat(64);
export const TEST_PREVIOUS_SECRET = 'b'.repeat(64);

export const TEST_AUTH_CONFIG: AuthConfig = {
  sessionSecret: TEST_SECRET,
  appBaseUrl: 'https://app.zapp.test',
  apiBaseUrl: 'https://api.zapp.test',
};

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
  /** Test-controlled clock, so expiry is asserted rather than waited for. */
  advance: (milliseconds: number) => void;
  now: () => Date;
}

export interface HarnessOptions {
  readonly config?: Partial<AuthConfig>;
  readonly users?: InMemoryUserStore;
}

/**
 * A fully wired app whose only fakes are the identity provider, the user store
 * and the clock — the session plugin, the routes, the denylist and the device
 * store are the shipping implementations.
 */
export function buildHarness(options: HarnessOptions = {}): Harness {
  const port = new FakeAuthPort();
  const users = options.users ?? new InMemoryUserStore();
  let offset = 0;
  const now = (): Date => new Date(Date.now() + offset);

  const app = buildApp({
    logger: false,
    auth: {
      port,
      users,
      config: { ...TEST_AUTH_CONFIG, ...options.config },
      denylist: createInMemoryTokenDenylist(now),
      deviceStore: createInMemoryDeviceStore(now),
      now,
    },
  });

  return {
    app,
    port,
    users,
    now,
    advance: (milliseconds: number) => {
      offset += milliseconds;
    },
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
