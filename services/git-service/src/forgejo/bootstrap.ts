import { ForgejoError, type ForgejoClient } from './client.js';

/**
 * Bringing a Forgejo instance to the state the rest of plan 06 assumes
 * (GIT-1).
 *
 * **Idempotent, and that is the requirement rather than a nicety.** This runs
 * after every deploy, and it runs against an instance that already has every
 * tenant's repositories on it. A step that recreated something would be a step
 * that deleted something first. So each one below is a question ("is it there?")
 * followed by a create *only* on "no", and the report says which of the two
 * happened — a second run that reports nothing but `present` and `ok` is the
 * proof, and `test/bootstrap.test.ts` asserts exactly that by counting the
 * writes the second run makes.
 *
 * Two of the steps create nothing at all and are here anyway, because a
 * bootstrap that only creates things cannot tell you the instance is *wrong*:
 *
 *   - the token has to belong to an **admin**, since everything this service
 *     does afterwards — creating organizations, creating repositories, creating
 *     the ephemeral users GIT-3 scopes tokens to — is an admin API call, and a
 *     non-admin token fails at the first project create instead of here;
 *   - an **anonymous** caller must be able to list no repositories at all. That
 *     is `REQUIRE_SIGNIN_VIEW` plus every repository being private
 *     (`infra/docker/forgejo/app.ini.prod`), and it is the single property whose
 *     absence would mean one tenant's source code is readable by the internet.
 *     Asserting it costs one request and is the cheapest smoke test in the
 *     system.
 *
 * The dev stack does *not* need this: `scripts/dev-up.sh` (FND-7) already
 * creates the admin user and mints its token. Running it there anyway is safe
 * and is how the script itself is exercised against a real instance.
 */

/**
 * The platform-owned namespace, named by plan 06 GIT-1.
 *
 * Not where projects go. A project's repository lives under a *per-tenant*
 * organization — `org_{ulid}/proj_{ulid}`, created lazily by GIT-2 — because a
 * shared namespace is a shared namespace, and the whole point of an organization
 * per tenant is that a repository-scoped token issued in one cannot even enumerate
 * the other. This organization is for repositories that belong to zapp rather
 * than to a tenant: project templates, and anything else the platform itself
 * owns.
 */
export const PLATFORM_ORG = 'zapp-projects';

export type StepOutcome =
  /** The step made a change. Expected on a first run, and never on a second. */
  | 'created'
  /** The thing was already there. This step made no write. */
  | 'present'
  /** A check, not a change. Always this. */
  | 'ok';

export interface BootstrapStep {
  readonly name: string;
  readonly outcome: StepOutcome;
  /** One line for the operator. Never a credential — see {@link BootstrapReport}. */
  readonly detail: string;
}

/**
 * What the run did, in order.
 *
 * Safe to print, and safe to paste into an incident channel: nothing in it is a
 * credential. The admin token is *used* by every step and named by none of them,
 * and the details below are versions, names and counts.
 */
export interface BootstrapReport {
  readonly steps: readonly BootstrapStep[];
  /** True when every step reported `present` or `ok` — the second-run signature. */
  readonly unchanged: boolean;
}

interface VersionResponse {
  readonly version?: string;
}

interface UserResponse {
  readonly login?: string;
  readonly is_admin?: boolean;
}

interface RepoSearchResponse {
  readonly data?: readonly unknown[];
}

/**
 * A bootstrap step failed in a way that means the instance is not usable, as
 * opposed to a transport hiccup. Named so the CLI can print it without a stack
 * trace and exit non-zero.
 */
export class BootstrapError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'BootstrapError';
  }
}

export interface BootstrapOptions {
  /** Overridable so a test can prove the create path without touching the real name. */
  readonly platformOrg?: string;
}

/** @throws {BootstrapError} when the instance is not in a usable state. */
export async function bootstrapForgejo(
  client: ForgejoClient,
  options: BootstrapOptions = {},
): Promise<BootstrapReport> {
  const platformOrg = options.platformOrg ?? PLATFORM_ORG;
  const steps: BootstrapStep[] = [];

  // 1. Reachable at all. Anonymous deliberately: `/api/healthz` is Forgejo's own
  //    liveness endpoint and needs no credential, so a failure here is "the host
  //    is down" rather than "the token is wrong" — two very different pages.
  try {
    await client.send({ method: 'GET', path: '/api/healthz', auth: { kind: 'anonymous' } });
  } catch (error) {
    throw new BootstrapError(
      `forgejo is not answering /api/healthz at ${client.baseUrl}`,
      error instanceof Error ? { cause: error } : undefined,
    );
  }
  steps.push({ name: 'health', outcome: 'ok', detail: client.baseUrl });

  // 2. Which build. Not a check — a line in the report, so that "what was running
  //    when this broke" is answerable from the deploy log.
  const version = await client.send<VersionResponse>({ method: 'GET', path: '/version' });
  steps.push({ name: 'version', outcome: 'ok', detail: version.body?.version ?? 'unknown' });

  // 3. The token, and that it is an admin's. Everything after this line is an
  //    admin API call.
  let admin: UserResponse | undefined;
  try {
    admin = (await client.send<UserResponse>({ method: 'GET', path: '/user' })).body;
  } catch (error) {
    if (error instanceof ForgejoError && error.status === 401) {
      throw new BootstrapError('FORGEJO_ADMIN_TOKEN was rejected by the instance', {
        cause: error,
      });
    }
    throw error;
  }
  if (admin?.is_admin !== true) {
    throw new BootstrapError(
      `FORGEJO_ADMIN_TOKEN belongs to "${admin?.login ?? 'an unknown user'}", who is not an administrator`,
    );
  }
  steps.push({ name: 'admin', outcome: 'ok', detail: admin.login ?? 'unknown' });

  // 4. The platform organization. Ask, then create only on a miss — see the
  //    module comment on why the order is not negotiable.
  const existing = await client.send({
    method: 'GET',
    path: `/orgs/${encodeURIComponent(platformOrg)}`,
    allow: [404],
  });
  if (existing.status === 404) {
    await client.send({
      method: 'POST',
      path: '/orgs',
      body: {
        username: platformOrg,
        // Private, like every organization this service creates. A public one
        // would make its member list and its repository list readable by any
        // authenticated user of the instance — including the ephemeral,
        // repository-scoped users of GIT-3.
        visibility: 'private',
        description: 'Platform-owned repositories. Tenant projects live under org_* organizations.',
      },
      // 422 is Forgejo's "already exists", which is reachable when two deploys
      // bootstrap at once. Both runs then agree the organization is present,
      // which is the answer either of them wanted.
      allow: [422],
    });
    steps.push({ name: 'platform-org', outcome: 'created', detail: platformOrg });
  } else {
    steps.push({ name: 'platform-org', outcome: 'present', detail: platformOrg });
  }

  // 5. What anonymity can see: nothing. A 401 or 403 is the strongest form of
  //    that answer (REQUIRE_SIGNIN_VIEW), and an empty result set is the weaker
  //    one that dev's configuration produces. Any repository listed here is a
  //    tenant's source code on the public internet.
  const anonymous = await client.send<RepoSearchResponse>({
    method: 'GET',
    path: '/repos/search?limit=1',
    auth: { kind: 'anonymous' },
    allow: [401, 403],
  });
  const visible = anonymous.body?.data?.length ?? 0;
  if (visible > 0) {
    throw new BootstrapError(
      `an anonymous caller can list ${String(visible)} repository(ies) — check REQUIRE_SIGNIN_VIEW and DEFAULT_PRIVATE`,
    );
  }
  steps.push({
    name: 'anonymous-visibility',
    outcome: 'ok',
    detail:
      anonymous.status === 200 ? 'no repositories listed' : `refused (${String(anonymous.status)})`,
  });

  return { steps, unchanged: steps.every((step) => step.outcome !== 'created') };
}
