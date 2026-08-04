import { describe, expect, it } from 'vitest';

import { BootstrapError, PLATFORM_ORG, bootstrapForgejo } from '../src/forgejo/bootstrap.js';
import { createFakeForgejo, type Route } from './support/fake-forgejo.js';

/**
 * The bootstrap's two obligations: it must be idempotent, and it must refuse an
 * instance that is not usable.
 *
 * The first is what plan 06 GIT-1 asks to be verified ("second run no-ops"), and
 * "no-ops" is asserted by *counting writes* rather than by trusting the report:
 * a run that recreated the platform organization would report `created` twice,
 * but a run that deleted and recreated it would report `created` twice as well
 * — and only the call log tells them apart.
 */

const PLATFORM_ORG_ROUTE = `GET /orgs/${PLATFORM_ORG}`;

/**
 * A fresh instance: healthy, admin token, nothing created yet. The fake answers
 * 404 for any route it has not been given, which is what "the organization is
 * not there" is.
 */
function fresh(): Record<string, Route> {
  return {
    'GET /api/healthz': { status: 200, body: {} },
    'GET /version': { status: 200, body: { version: '9.0.3+gitea-1.22.0' } },
    'GET /user': { status: 200, body: { login: 'zapp-admin', is_admin: true } },
    'GET /repos/search?limit=1': { status: 200, body: { data: [] } },
    'POST /orgs': { status: 201, body: { username: PLATFORM_ORG } },
  };
}

/** An instance that already has everything. The steady state after a first run. */
function bootstrapped(): Record<string, Route> {
  return { ...fresh(), [PLATFORM_ORG_ROUTE]: { status: 200, body: { username: PLATFORM_ORG } } };
}

describe('bootstrapForgejo', () => {
  it('creates the platform organization on a fresh instance', async () => {
    const forgejo = createFakeForgejo(fresh());

    const report = await bootstrapForgejo(forgejo);

    expect(report.unchanged).toBe(false);
    expect(report.steps.find((step) => step.name === 'platform-org')?.outcome).toBe('created');
    expect(forgejo.writes.map((call) => `${call.method} ${call.path}`)).toEqual(['POST /orgs']);
    // Private, and named. A public organization would make its repository list
    // readable by every authenticated user of the instance — including the
    // ephemeral, repository-scoped users of GIT-3.
    expect(forgejo.writes[0]?.body).toMatchObject({
      username: PLATFORM_ORG,
      visibility: 'private',
    });
  });

  it('writes nothing at all on a second run', async () => {
    const forgejo = createFakeForgejo(bootstrapped());

    const report = await bootstrapForgejo(forgejo);

    expect(report.unchanged).toBe(true);
    // The assertion that matters. Not "the report said present" — *no write was
    // issued*, so there is no ordering of creates and deletes that could have
    // produced this run.
    expect(forgejo.writes).toEqual([]);
    expect(report.steps.map((step) => step.name)).toEqual([
      'health',
      'version',
      'admin',
      'platform-org',
      'anonymous-visibility',
    ]);
  });

  it('is idempotent across a create and the run that follows it', async () => {
    const forgejo = createFakeForgejo(fresh());

    const first = await bootstrapForgejo(forgejo);
    // What the instance looks like afterwards: the organization now answers.
    forgejo.route(PLATFORM_ORG_ROUTE, { status: 200, body: { username: PLATFORM_ORG } });
    const writesAfterFirst = forgejo.writes.length;
    const second = await bootstrapForgejo(forgejo);

    expect(first.unchanged).toBe(false);
    expect(second.unchanged).toBe(true);
    expect(forgejo.writes.length).toBe(writesAfterFirst);
  });

  it('tolerates a concurrent bootstrap creating the organization first', async () => {
    // Two deploys racing. Forgejo answers the loser's create with 422; both runs
    // then agree the organization is present, which is what either of them
    // wanted.
    const forgejo = createFakeForgejo({ ...fresh(), 'POST /orgs': { status: 422 } });

    await expect(bootstrapForgejo(forgejo)).resolves.toMatchObject({ unchanged: false });
  });

  it('refuses an instance that is not answering', async () => {
    const forgejo = createFakeForgejo({
      'GET /api/healthz': { error: new Error('connect ECONNREFUSED') },
    });

    await expect(bootstrapForgejo(forgejo)).rejects.toBeInstanceOf(BootstrapError);
    // Nothing else was attempted: a host that is down is not a host to ask five
    // more questions of.
    expect(forgejo.calls).toHaveLength(1);
  });

  it('refuses a token that is not an administrator', async () => {
    const forgejo = createFakeForgejo({
      ...bootstrapped(),
      'GET /user': { status: 200, body: { login: 'someone', is_admin: false } },
    });

    // Caught here rather than at the first project create, which is where a
    // non-admin token otherwise fails — in a request that belongs to a customer.
    await expect(bootstrapForgejo(forgejo)).rejects.toThrow(/not an administrator/);
    expect(forgejo.writes).toEqual([]);
  });

  it('refuses a token the instance rejects', async () => {
    const forgejo = createFakeForgejo({ ...bootstrapped(), 'GET /user': { status: 401 } });

    await expect(bootstrapForgejo(forgejo)).rejects.toThrow(/FORGEJO_ADMIN_TOKEN was rejected/);
  });

  it('refuses an instance where an anonymous caller can list a repository', async () => {
    const forgejo = createFakeForgejo({
      ...bootstrapped(),
      'GET /repos/search?limit=1': { status: 200, body: { data: [{ full_name: 'org_x/proj_y' }] } },
    });

    // The one failure in this file that is a security finding rather than a
    // misconfiguration: a repository listed anonymously is a tenant's source
    // code on the public internet.
    await expect(bootstrapForgejo(forgejo)).rejects.toThrow(/anonymous caller can list/);
  });

  it('accepts an instance that refuses anonymous callers outright', async () => {
    // REQUIRE_SIGNIN_VIEW, which is the production configuration. A stronger
    // answer than an empty list, and the checker must not read it as a failure.
    const forgejo = createFakeForgejo({
      ...bootstrapped(),
      'GET /repos/search?limit=1': { status: 401 },
    });

    const report = await bootstrapForgejo(forgejo);

    expect(report.steps.at(-1)).toMatchObject({
      name: 'anonymous-visibility',
      outcome: 'ok',
      detail: 'anonymous callers refused (401)',
    });
  });

  it('reports the anonymous check as unproven when there is nothing to hide', async () => {
    // A fresh instance: anonymous lists nothing, and so does the admin. "Nobody
    // saw a repository" is true of a wide-open instance too, so reporting it as
    // a pass was a green tick that could not go red on the one run where it
    // mattered most (GIT review).
    const forgejo = createFakeForgejo({
      ...bootstrapped(),
      'GET /repos/search?limit=1': { status: 200, body: { data: [] } },
    });

    const report = await bootstrapForgejo(forgejo);

    expect(report.steps.at(-1)).toMatchObject({
      name: 'anonymous-visibility',
      outcome: 'unproven',
    });
  });

  it('passes the anonymous check only when the admin can see what anonymity cannot', async () => {
    const forgejo = createFakeForgejo({
      ...bootstrapped(),
      'GET /repos/search?limit=1': {
        // Anonymous first, then the admin's control request against the same
        // path: the fake's `then` is what lets one route answer twice.
        status: 200,
        body: { data: [] },
        then: { status: 200, body: { data: [{ full_name: 'org_x/proj_y' }] } },
      },
    });

    const report = await bootstrapForgejo(forgejo);

    expect(report.steps.at(-1)).toMatchObject({
      name: 'anonymous-visibility',
      outcome: 'ok',
      detail: 'repositories exist and anonymous callers list none',
    });
  });
});
