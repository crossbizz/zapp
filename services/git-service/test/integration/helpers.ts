import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { createDb, type Db } from '@zapp/db';
import { migrate } from 'drizzle-orm/postgres-js/migrator';

import { createForgejoClient, type ForgejoClient } from '../../src/forgejo/client.js';

/**
 * The Forgejo rail for this service's integration suites.
 *
 * Env-gated on the FND-7 dev stack, exactly as the control plane's suites are
 * gated on `DATABASE_URL`: with no `FORGEJO_URL` and `FORGEJO_ADMIN_TOKEN` these
 * suites **skip loudly** and never pass silently. CI has no Forgejo, so that is
 * the normal outcome there — and the warning below is what stops "all green"
 * from being read as "the cross-repo denial was checked".
 *
 * Run them with the dev stack up:
 *
 *   ./scripts/dev-up.sh
 *   pnpm --filter @zapp/git-service test:integration
 *
 * (`scripts/dev-up.sh` writes both variables into `.env.local.forgejo`; the
 * command above loads them — see the package script.)
 *
 * Everything these suites create is namespaced by a random suffix and removed in
 * `afterAll`, because they run against a developer's *actual* dev instance.
 * Nothing here deletes anything it did not create.
 */

const FORGEJO_URL = process.env['FORGEJO_URL'] ?? '';
const FORGEJO_ADMIN_TOKEN = process.env['FORGEJO_ADMIN_TOKEN'] ?? '';

export const hasForgejo = FORGEJO_URL !== '' && FORGEJO_ADMIN_TOKEN !== '';

if (!hasForgejo) {
  console.warn(
    '[@zapp/git-service] Forgejo integration tests skipped: FORGEJO_URL / FORGEJO_ADMIN_TOKEN are unset — start the dev stack with ./scripts/dev-up.sh',
  );
}

export const forgejoUrl = (): string => {
  if (!hasForgejo) {
    throw new Error('forgejoUrl requires FORGEJO_URL — guard the suite with `hasForgejo`');
  }
  return FORGEJO_URL.replace(/\/+$/, '');
};

export const adminToken = (): string => {
  if (!hasForgejo) {
    throw new Error('adminToken requires FORGEJO_ADMIN_TOKEN — guard the suite with `hasForgejo`');
  }
  return FORGEJO_ADMIN_TOKEN;
};

/**
 * A client against the dev instance. The timeout is generous rather than the
 * production five seconds: a laptop running the whole compose stack is slower
 * than a deployment, and a flaky suite teaches people to ignore it.
 */
export function integrationClient(): ForgejoClient {
  return createForgejoClient({
    baseUrl: forgejoUrl(),
    adminToken: adminToken(),
    timeoutMs: 30_000,
  });
}

const run = promisify(execFile);

export interface GitResult {
  readonly ok: boolean;
  /** stdout and stderr together: git puts the interesting part in stderr. */
  readonly output: string;
}

/**
 * Runs `git`, reporting failure as a value rather than as an exception.
 *
 * Half the assertions in these suites are about a command that *must* fail — a
 * scoped token cloning somebody else's repository, a write token pushing to a
 * protected branch — and `rejects.toThrow()` cannot tell "refused by the server"
 * from "git is not installed".
 */
export async function git(cwd: string, ...args: string[]): Promise<GitResult> {
  try {
    const { stdout, stderr } = await run('git', args, {
      cwd,
      env: {
        ...process.env,
        // Never prompt. Without this, a refused credential turns a test run into
        // a hung process waiting on a terminal that is not there.
        GIT_TERMINAL_PROMPT: '0',
        GIT_ASKPASS: 'true',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_SYSTEM: '/dev/null',
      },
    });
    return { ok: true, output: `${stdout}${stderr}` };
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; message?: string };
    return {
      ok: false,
      output: `${failure.stdout ?? ''}${failure.stderr ?? ''}${failure.message ?? ''}`,
    };
  }
}

/** A clone URL with credentials in it, for `git` — never logged, never stored. */
export function credentialUrl(cloneUrl: string, username: string, password: string): string {
  const url = new URL(cloneUrl);
  url.username = encodeURIComponent(username);
  url.password = encodeURIComponent(password);
  return url.toString();
}

/** A scratch directory, removed by the caller. */
export async function workspace(): Promise<string> {
  return await mkdtemp(join(tmpdir(), 'zapp-git-'));
}

export async function removeWorkspace(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true });
}

/**
 * Waits for `check` to return a value, polling.
 *
 * Forgejo processes a push **asynchronously**: for a second or two after `git
 * push` returns, `GET /branches/{name}` still answers 404 and the repository
 * still reports itself empty. A fixed sleep would be either flaky or slow, and
 * the provider deliberately does not paper over it — see the comment on
 * `src/provider/forgejo.ts`.
 */
export async function eventually<T>(
  check: () => Promise<T | undefined>,
  what: string,
  timeoutMs = 15_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value !== undefined) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/**
 * The database rail, for the one suite that needs it.
 *
 * `audit_events` is where GIT-3's `git_token.minted` rows land, and that they
 * land is the half of "audited" a fake sink cannot prove. Gated separately from
 * Forgejo: a developer with the dev stack up has both, and CI has neither.
 *
 * Same two rules as every other suite in this repository: never touch the
 * database `DATABASE_URL` points at, and never truncate anything whose name does
 * not end in `_test`. This one goes further and truncates nothing at all — it
 * writes rows under ids it minted and reads them back by id, because
 * `audit_events` is append-only by trigger (`packages/db/drizzle/0006`) and a
 * suite that reached for the documented escape hatch to tidy up after itself
 * would be a suite that can disarm an audit ledger.
 */
const DATABASE_URL = process.env['DATABASE_URL'] ?? '';

export const hasDatabase = DATABASE_URL !== '';

if (!hasDatabase) {
  console.warn(
    '[@zapp/git-service] audit integration tests skipped: DATABASE_URL is unset — start the dev stack with ./scripts/dev-up.sh',
  );
}

const SAFE_DATABASE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SERVICE_SUFFIX = '_git_service_test';

/** Its own `${name}_git_service_test`, so parallel suites cannot clobber each other. */
export function testDatabaseUrl(url: string): string {
  const parsed = new URL(url);
  const name = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  if (name === '') {
    throw new Error('DATABASE_URL names no database — expected something like .../zapp');
  }
  const testName = `${name.replace(/(_git_service)?_test$/, '')}${SERVICE_SUFFIX}`;
  if (!SAFE_DATABASE_NAME.test(testName)) {
    throw new Error(`refusing to use "${testName}" as a database name`);
  }
  parsed.pathname = `/${testName}`;
  return parsed.toString();
}

/** Opens (creating and migrating as needed) this service's own test database. */
export async function setUpTestDatabase(): Promise<Db & { url: string }> {
  if (!hasDatabase) {
    throw new Error('setUpTestDatabase requires DATABASE_URL — guard the suite with `hasDatabase`');
  }
  const url = testDatabaseUrl(DATABASE_URL);
  const name = decodeURIComponent(new URL(url).pathname.replace(/^\//, ''));

  const maintenanceUrl = new URL(url);
  maintenanceUrl.pathname = '/postgres';
  const admin = createDb(maintenanceUrl.toString());
  try {
    const existing = await admin.sql<{ oid: number }[]>`
      select oid from pg_database where datname = ${name}
    `;
    if (existing.length === 0) {
      await admin.sql.unsafe(`create database "${name}"`);
    }
  } catch (error) {
    // 42P04: another suite created it between the check and the create.
    if ((error as { code?: unknown }).code !== '42P04') {
      throw error;
    }
  } finally {
    await admin.close();
  }

  const handle = createDb(url);
  // The migrations are @zapp/db's, and the path is relative because they are
  // data rather than code: nothing imports this directory.
  await migrate(handle.db, {
    migrationsFolder: fileURLToPath(new URL('../../../../packages/db/drizzle', import.meta.url)),
  });
  return { ...handle, url };
}
