import { randomBytes } from 'node:crypto';

import type { ServiceName } from '@zapp/config';
import { ApprovedTemplateSourceSchema } from '@zapp/config/templates';
import { internalRepoRef, parseInternalRepoRef } from '@zapp/contracts';

import type { GitAuditSink } from './audit.js';
import { ForgejoError, type ForgejoClient } from './forgejo/client.js';

/**
 * Repository-scoped, short-lived Git credentials (plan 06 GIT-3).
 *
 * PRD §19.1: "read and write tokens scoped to one repository". Forgejo cannot do
 * that directly — its access tokens carry *global* scopes (`read:repository`
 * applies to every repository the owner can see) and have no expiry at all — so
 * the scoping has to come from somewhere else. It comes from the **identity**:
 *
 *   1. An ephemeral, `restricted` user is created for this one grant. A
 *      restricted user in Forgejo can see nothing it has not been explicitly
 *      given, not even public repositories.
 *   2. It is made a collaborator on exactly one private repository, at `read` or
 *      `write`.
 *   3. A token is minted *as that user*.
 *
 * The result is a credential whose reach is a property of Forgejo's own
 * permission check rather than of a scope string we hope is honoured: every other
 * repository — in this tenant and in every other — answers 404 to it, over the
 * API and over `git clone` alike. `test/integration/tokens.test.ts` proves that
 * against the real instance, because it is the security property that matters and
 * a mocked one would only prove what we believed while writing this.
 *
 * (Token creation is the one Forgejo endpoint that refuses token auth and
 * requires HTTP basic, which is why the ephemeral user gets a generated password.
 * That password is used once, in this function, and is never stored or returned.)
 *
 * **Expiry is ours to enforce, and the expiry time is written into the
 * username.** Forgejo has no notion of a token that stops working, so
 * {@link TokenService.sweepExpired} deletes ephemeral users whose deadline has
 * passed, and deleting a user destroys its tokens. Encoding the deadline in the
 * name — `zt-<epochSeconds>-<random>` — is what keeps that restart-safe and
 * stateless: the Git host *is* the record of which grants exist, so a process
 * that crashes between minting and sweeping leaks nothing that the next sweep
 * will not find. A table of outstanding grants would be a second source of truth
 * that can disagree with the first, and the disagreement would be in the
 * direction of a credential nobody knows about.
 *
 * The exposure this leaves is a token that remains usable between its stated
 * expiry and the next sweep — so **the service sweeps itself**, on a timer, once
 * a minute (`src/sweep.ts`, started in `src/server.ts`). The first cut of this
 * task shipped the sweep as a route and left the schedule to an ops runbook,
 * which the review refused and was right to: the deployed Forgejo has a public
 * IPv4, a public IPv6 and a TLS certificate (`infra/terraform/forgejo.tf`), so
 * an unswept token is reachable from the internet for as long as nobody reads
 * the runbook. A bound nothing enforces is not a bound. The route stays, for an
 * operator who wants to force one now.
 */

/** What a caller may ask for. Anything else is not expressible. */
export const TOKEN_ACCESS_LEVELS = ['read', 'write'] as const;

export type TokenAccess = (typeof TOKEN_ACCESS_LEVELS)[number];

/**
 * The ceiling, in seconds.
 *
 * Ten minutes, mirroring `MAX_SERVICE_TOKEN_TTL_SECONDS` (plan 02 CP-8) — and the
 * reasoning transfers exactly: this credential is minted per operation, it
 * travels to a sandbox that runs model-generated code, and the window a captured
 * one is worth anything in should be measured in minutes rather than hours.
 * Enforced at minting, so a caller asking for a day-long credential fails at its
 * own call rather than getting one.
 */
export const MAX_TOKEN_TTL_SECONDS = 600;

/**
 * The default, and the number plan 06's constraints name. Long enough for a clone
 * of a large repository plus a retry, short enough to be uninteresting to steal.
 */
export const DEFAULT_TOKEN_TTL_SECONDS = 300;

/**
 * The shape of an ephemeral user's name: `zt-<expiry epoch seconds>-<random>`.
 *
 * Load-bearing rather than cosmetic — the sweep reads the deadline back out of
 * it. The random suffix is what makes concurrent grants for one repository
 * distinct, and 12 hex characters is 48 bits, which is not a collision anyone
 * will see. Forgejo caps usernames at 40 characters; this is 26. The audit
 * boundary uses this same pattern to validate the non-secret `tokenUser`.
 */
export const EPHEMERAL_USERNAME_PATTERN = /^zt-(\d{10,12})-[0-9a-f]{12}$/;

const EPHEMERAL_PREFIX = 'zt-';

/**
 * How many accounts to read per request, everywhere this file pages.
 *
 * One constant, because the loop condition is `batch.length < PAGE_SIZE` — a
 * page size that disagreed with the number in the query string would stop the
 * loop one page early on a full page, silently.
 */
const PAGE_SIZE = 50;

export function ephemeralUsername(expiresAt: Date): string {
  const epoch = Math.floor(expiresAt.getTime() / 1000);
  return `${EPHEMERAL_PREFIX}${String(epoch)}-${randomBytes(6).toString('hex')}`;
}

/** The deadline encoded in `username`, or `undefined` if this is not one of ours. */
export function expiryOf(username: string): Date | undefined {
  const match = EPHEMERAL_USERNAME_PATTERN.exec(username);
  if (match?.[1] === undefined) {
    return undefined;
  }
  return new Date(Number(match[1]) * 1000);
}

export interface MintTokenInput {
  readonly organizationId: string;
  readonly projectId: string;
  readonly access: TokenAccess;
  /** Defaults to {@link DEFAULT_TOKEN_TTL_SECONDS}; never more than the ceiling. */
  readonly ttlSec?: number;
  /** Who asked, from the verified service token — never from a request body. */
  readonly requestingService: ServiceName;
  /** Run and task attribution, when the caller has one. */
  readonly runId?: string;
  readonly taskId?: string;
}

export interface MintedToken {
  /** The secret. Returned once, never stored, never logged. */
  readonly token: string;
  /** The ephemeral user it belongs to. Safe to log — it is an identifier, not a credential. */
  readonly username: string;
  /** Where to clone from. No credential in it; the caller supplies one. */
  readonly cloneUrl: string;
  readonly expiresAt: Date;
}

export interface MintRepositoryTokenInput extends MintTokenInput {
  /** The validated restore target, which can differ from the source project during a drill. */
  readonly targetRef: string;
  /** Forgejo's immutable repository id from the append-only target receipt. */
  readonly expectedRepositoryId: number;
  /**
   * Persists the non-secret identity before Forgejo creates it, so a crashed or
   * failed restore can resume revocation without retaining the token/password.
   */
  readonly onIdentityAllocated?: (identity: {
    readonly username: string;
    readonly expiresAt: Date;
  }) => Promise<void>;
  /**
   * Confirms that Forgejo finished creating the identity, before any repository
   * grant or token exists. Restore cleanup uses this durable boundary to decide
   * whether a 404 can be terminal or must remain pending until expiry.
   */
  readonly onIdentityCreated?: (identity: {
    readonly username: string;
    readonly expiresAt: Date;
  }) => Promise<void>;
}

export interface MintApprovedTemplateSourceInput {
  readonly organizationId: string;
  readonly projectId: string;
  /** Validated platform-owned source; never accepted from an HTTP request. */
  readonly repositoryRef: string;
  readonly ttlSec?: number;
  readonly requestingService: ServiceName;
}

export interface TokenService {
  /** @throws Error for a TTL over the ceiling; {@link ForgejoError} if the Git host refuses. */
  mint(input: MintTokenInput): Promise<MintedToken>;
  /**
   * Mints only after the collaborator grant is proven to belong to the received
   * immutable repository id. Used by restore so a path replacement cannot
   * inherit a force-push credential.
   */
  mintForRepository(input: MintRepositoryTokenInput): Promise<MintedToken>;
  /**
   * Revokes every outstanding grant on a project's repository. Called when a
   * project is deleted: the repository goes, and every credential that could
   * still reach it goes with it rather than waiting out its TTL.
   */
  revokeForProject(input: {
    readonly organizationId: string;
    readonly projectId: string;
    readonly requestingService: ServiceName;
  }): Promise<number>;
  /** Revokes one operation-scoped identity immediately after its caller finishes. */
  revokeEphemeral(input: {
    readonly organizationId: string;
    readonly projectId: string;
    readonly username: string;
    readonly requestingService: ServiceName;
  }): Promise<void>;
  /** Deletes every ephemeral user whose deadline has passed. Idempotent; safe to run often. */
  sweepExpired(now?: Date): Promise<number>;
}

/** The additional source-only capability held by the deployed composition. */
export interface ApprovedTemplateTokenService extends TokenService {
  mintApprovedTemplateSource(input: MintApprovedTemplateSourceInput): Promise<MintedToken>;
  revokeApprovedTemplateSource(input: {
    readonly organizationId: string;
    readonly projectId: string;
    readonly repositoryRef: string;
    readonly username: string;
    readonly requestingService: ServiceName;
  }): Promise<void>;
}

interface UserResponse {
  readonly login?: string;
}

/** Forgejo's collaborator permission, and the token scope that goes with it. */
const FORGEJO_ACCESS: Record<TokenAccess, { permission: string; scope: string }> = {
  read: { permission: 'read', scope: 'read:repository' },
  write: { permission: 'write', scope: 'write:repository' },
};

interface TokenResponse {
  readonly sha1?: string;
}

interface RepositoryResponse {
  readonly id?: number;
  readonly clone_url?: string;
}

export interface TokenServiceOptions {
  readonly client: ForgejoClient;
  readonly audit: GitAuditSink;
  /** Injected in tests so expiry is asserted rather than waited for. */
  readonly now?: () => Date;
}

export function createTokenService(options: TokenServiceOptions): ApprovedTemplateTokenService {
  const { client, audit } = options;
  const now = options.now ?? ((): Date => new Date());

  function repoPath(ref: string): string {
    const [owner, name, ...extra] = ref.split('/');
    if (owner === undefined || name === undefined || extra.length !== 0) {
      throw new Error('Invalid repository ref');
    }
    return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
  }

  /** Removes an ephemeral user, which destroys its tokens. Idempotent. */
  async function deleteUser(username: string): Promise<void> {
    await client.send({
      method: 'DELETE',
      // `purge` so the account leaves nothing behind. A repository-scoped user
      // owns no repositories and has authored nothing, so there is nothing this
      // could take with it.
      path: `/admin/users/${encodeURIComponent(username)}?purge=true`,
      allow: [404],
    });
  }

  async function revokeOperationCredential(
    input: {
      readonly organizationId: string;
      readonly projectId: string;
      readonly username: string;
      readonly requestingService: ServiceName;
    },
    repositoryRef: string,
  ): Promise<void> {
    if (expiryOf(input.username) === undefined) {
      throw new Error('Refusing to revoke a non-ephemeral Git identity');
    }
    await deleteUser(input.username);
    await audit.record({
      organizationId: input.organizationId,
      action: 'git_token.revoked',
      projectId: input.projectId,
      requestingService: input.requestingService,
      occurredAt: now(),
      metadata: { internalRepoRef: repositoryRef, revoked: 1 },
    });
  }

  async function mintRepositoryToken(
    input: MintTokenInput,
    ref: string,
    expectedRepositoryId?: number,
    onIdentityAllocated?: MintRepositoryTokenInput['onIdentityAllocated'],
    onIdentityCreated?: MintRepositoryTokenInput['onIdentityCreated'],
  ): Promise<MintedToken> {
    const ttlSec = input.ttlSec ?? DEFAULT_TOKEN_TTL_SECONDS;
    if (!Number.isInteger(ttlSec) || ttlSec <= 0 || ttlSec > MAX_TOKEN_TTL_SECONDS) {
      throw new Error(
        `mint: ttlSec must be a whole number of seconds in 1…${String(MAX_TOKEN_TTL_SECONDS)}`,
      );
    }

    const path = repoPath(ref);
    const issuedAt = now();
    const expiresAt = new Date(issuedAt.getTime() + ttlSec * 1000);
    const username = ephemeralUsername(expiresAt);
    const access = FORGEJO_ACCESS[input.access];

    const repository = await client.send<RepositoryResponse>({ method: 'GET', path });
    let cloneUrl = repository.body?.clone_url;
    if (cloneUrl === undefined || cloneUrl === '') {
      throw new ForgejoError('GET', path, 0, 'repository response carried no clone_url');
    }
    if (expectedRepositoryId !== undefined && repository.body?.id !== expectedRepositoryId) {
      throw new Error('Restore repository identity does not match the durable receipt');
    }

    await onIdentityAllocated?.({ username, expiresAt });

    if (now().getTime() >= expiresAt.getTime()) {
      throw new Error('Credential identity expired before Forgejo creation');
    }

    const password = randomBytes(24).toString('base64url');

    try {
      await client.send({
        method: 'POST',
        path: '/admin/users',
        body: {
          username,
          email: `${username}@ephemeral.zapp.invalid`,
          password,
          must_change_password: false,
          restricted: true,
          visibility: 'private',
        },
      });
      await onIdentityCreated?.({ username, expiresAt });

      await client.send({
        method: 'PUT',
        path: `${path}/collaborators/${encodeURIComponent(username)}`,
        body: { permission: access.permission },
      });

      if (expectedRepositoryId !== undefined) {
        const grantedRepository = await client.send<RepositoryResponse>({ method: 'GET', path });
        if (grantedRepository.body?.id !== expectedRepositoryId) {
          throw new Error('Restore repository identity changed during credential grant');
        }
        cloneUrl = grantedRepository.body.clone_url;
        if (cloneUrl === undefined || cloneUrl === '') {
          throw new ForgejoError('GET', path, 0, 'repository response carried no clone_url');
        }
      }

      const minted = await client.send<TokenResponse>({
        method: 'POST',
        path: `/users/${encodeURIComponent(username)}/tokens`,
        auth: { kind: 'basic', username, password },
        body: {
          name: `zapp-${String(Math.floor(issuedAt.getTime() / 1000))}`,
          scopes: [access.scope],
        },
      });

      const token = minted.body?.sha1;
      if (token === undefined || token === '') {
        throw new ForgejoError('POST', `/users/${username}/tokens`, 0, 'no token in response');
      }

      await audit.record({
        organizationId: input.organizationId,
        action: 'git_token.minted',
        projectId: input.projectId,
        requestingService: input.requestingService,
        occurredAt: issuedAt,
        metadata: {
          internalRepoRef: ref,
          access: input.access,
          ttlSec,
          expiresAt: expiresAt.toISOString(),
          tokenUser: username,
          runId: input.runId ?? null,
          taskId: input.taskId ?? null,
        },
      });

      return { token, username, cloneUrl, expiresAt };
    } catch (error) {
      await deleteUser(username).catch(() => {
        // The restart-safe expiry sweep remains the fallback for this identity.
      });
      throw error;
    }
  }

  return {
    async mint(input: MintTokenInput): Promise<MintedToken> {
      const ref = internalRepoRef(input);
      return await mintRepositoryToken(input, ref);
    },

    async mintForRepository(input: MintRepositoryTokenInput): Promise<MintedToken> {
      parseInternalRepoRef(input.targetRef);
      if (!Number.isInteger(input.expectedRepositoryId) || input.expectedRepositoryId <= 0) {
        throw new Error('Invalid expected repository identity');
      }
      return await mintRepositoryToken(
        input,
        input.targetRef,
        input.expectedRepositoryId,
        input.onIdentityAllocated,
        input.onIdentityCreated,
      );
    },

    async mintApprovedTemplateSource(input): Promise<MintedToken> {
      const repositoryRef = ApprovedTemplateSourceSchema.shape.repoRef.parse(input.repositoryRef);
      const path = repoPath(repositoryRef);
      const repository = await client.send<RepositoryResponse>({ method: 'GET', path });
      const expectedRepositoryId = repository.body?.id;
      if (
        expectedRepositoryId === undefined ||
        !Number.isInteger(expectedRepositoryId) ||
        expectedRepositoryId <= 0
      ) {
        throw new ForgejoError('GET', path, 0, 'repository response carried no valid id');
      }
      return await mintRepositoryToken(
        {
          organizationId: input.organizationId,
          projectId: input.projectId,
          access: 'read',
          ...(input.ttlSec === undefined ? {} : { ttlSec: input.ttlSec }),
          requestingService: input.requestingService,
        },
        repositoryRef,
        expectedRepositoryId,
      );
    },

    async revokeForProject(input): Promise<number> {
      const ref = internalRepoRef(input);
      const ephemeral: string[] = [];

      /**
       * Paginated, and reading every page before deleting anything — the same
       * shape as {@link TokenService.sweepExpired} and for both of its reasons.
       *
       * The first cut asked for `limit=100` once and stopped, which is a cap
       * rather than a page: a project with more than a hundred outstanding
       * grants would have had the surplus survive this call, and "revoked when
       * the project was deleted" would have been true of some of its
       * credentials. A hundred is not far-fetched for a project minting one
       * token per operation. (GIT review.)
       *
       * Reading first also matters here for the same reason it does in the
       * sweep: removing a collaborator shifts the rest one place earlier, so a
       * delete-while-paging loop skips whichever entry moved onto a page it had
       * already read.
       */
      for (let page = 1; ; page += 1) {
        const collaborators = await client.send<readonly UserResponse[]>({
          method: 'GET',
          path: `${repoPath(ref)}/collaborators?limit=${String(PAGE_SIZE)}&page=${String(page)}`,
          // A repository that is already gone has no collaborators to revoke,
          // and "the project was deleted" is precisely when this is called.
          allow: [404],
        });
        const batch = collaborators.body ?? [];
        for (const user of batch) {
          const login = user.login ?? '';
          // Only accounts this service minted. A human collaborator on the
          // repository is not a credential to revoke, and deleting one would be
          // deleting a person.
          if (expiryOf(login) !== undefined) {
            ephemeral.push(login);
          }
        }
        if (batch.length < PAGE_SIZE) {
          break;
        }
      }

      for (const username of ephemeral) {
        await deleteUser(username);
      }

      if (ephemeral.length > 0) {
        await audit.record({
          organizationId: input.organizationId,
          action: 'git_token.revoked',
          projectId: input.projectId,
          requestingService: input.requestingService,
          occurredAt: now(),
          metadata: {
            internalRepoRef: ref,
            revoked: ephemeral.length,
          },
        });
      }
      return ephemeral.length;
    },

    async revokeEphemeral(input): Promise<void> {
      const ref = internalRepoRef(input);
      await revokeOperationCredential(input, ref);
    },

    async revokeApprovedTemplateSource(input): Promise<void> {
      const repositoryRef = ApprovedTemplateSourceSchema.shape.repoRef.parse(input.repositoryRef);
      await revokeOperationCredential(input, repositoryRef);
    },

    async sweepExpired(at?: Date): Promise<number> {
      const deadline = at ?? now();
      const expired: string[] = [];

      /**
       * Every page is read before anything is deleted.
       *
       * Deleting while paging would be a correctness bug rather than a style
       * one: removing an account shifts every later account one place earlier,
       * so the first entry of page 2 moves onto page 1 *after* page 1 has been
       * read — and is never looked at. The credential it belongs to would then
       * survive until some later sweep happened to catch it, which is exactly
       * the guarantee this function exists to provide.
       */
      for (let page = 1; ; page += 1) {
        const users = await client.send<readonly UserResponse[]>({
          method: 'GET',
          path: `/admin/users?limit=${String(PAGE_SIZE)}&page=${String(page)}`,
        });
        const batch = users.body ?? [];
        for (const user of batch) {
          const login = user.login ?? '';
          const expiresAt = expiryOf(login);
          // Only ours, and only past its deadline. Every other account on the
          // instance — the platform admin above all — fails the pattern, so
          // there is no page and no ordering in which this deletes one.
          if (expiresAt !== undefined && expiresAt.getTime() <= deadline.getTime()) {
            expired.push(login);
          }
        }
        if (batch.length < PAGE_SIZE) {
          break;
        }
      }

      for (const login of expired) {
        await deleteUser(login);
      }
      return expired.length;
    },
  };
}
