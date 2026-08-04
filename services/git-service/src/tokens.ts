import { randomBytes } from 'node:crypto';

import type { ServiceName } from '@zapp/config';
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
 * The exposure this leaves is honest and bounded: a token remains usable between
 * its stated expiry and the next sweep. That is a scheduling property, not a hole
 * that widens — the sweep is idempotent, cheap, and safe to run every minute.
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
 * will see. Forgejo caps usernames at 40 characters; this is 26.
 */
const EPHEMERAL_USER = /^zt-(\d{10,12})-[0-9a-f]{12}$/;

const EPHEMERAL_PREFIX = 'zt-';

export function ephemeralUsername(expiresAt: Date): string {
  const epoch = Math.floor(expiresAt.getTime() / 1000);
  return `${EPHEMERAL_PREFIX}${String(epoch)}-${randomBytes(6).toString('hex')}`;
}

/** The deadline encoded in `username`, or `undefined` if this is not one of ours. */
export function expiryOf(username: string): Date | undefined {
  const match = EPHEMERAL_USER.exec(username);
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
  /** Why. Written to the audit row; a grant nobody can explain is one nobody can review. */
  readonly reason: string;
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

export interface TokenService {
  /** @throws Error for a TTL over the ceiling; {@link ForgejoError} if the Git host refuses. */
  mint(input: MintTokenInput): Promise<MintedToken>;
  /**
   * Revokes every outstanding grant on a project's repository. Called when a
   * project is deleted: the repository goes, and every credential that could
   * still reach it goes with it rather than waiting out its TTL.
   */
  revokeForProject(input: {
    readonly organizationId: string;
    readonly projectId: string;
    readonly requestingService: ServiceName;
    readonly reason: string;
  }): Promise<number>;
  /** Deletes every ephemeral user whose deadline has passed. Idempotent; safe to run often. */
  sweepExpired(now?: Date): Promise<number>;
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
  readonly clone_url?: string;
}

export interface TokenServiceOptions {
  readonly client: ForgejoClient;
  readonly audit: GitAuditSink;
  /** Injected in tests so expiry is asserted rather than waited for. */
  readonly now?: () => Date;
}

export function createTokenService(options: TokenServiceOptions): TokenService {
  const { client, audit } = options;
  const now = options.now ?? ((): Date => new Date());

  function repoPath(ref: string): string {
    const { owner, name } = parseInternalRepoRef(ref);
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

  return {
    async mint(input: MintTokenInput): Promise<MintedToken> {
      const ttlSec = input.ttlSec ?? DEFAULT_TOKEN_TTL_SECONDS;
      if (!Number.isInteger(ttlSec) || ttlSec <= 0 || ttlSec > MAX_TOKEN_TTL_SECONDS) {
        // Refused at minting, so a caller that wants a long-lived credential
        // fails at its own call rather than quietly receiving one.
        throw new Error(
          `mint: ttlSec must be a whole number of seconds in 1…${String(MAX_TOKEN_TTL_SECONDS)}`,
        );
      }

      const ref = internalRepoRef(input);
      const path = repoPath(ref);
      const issuedAt = now();
      const expiresAt = new Date(issuedAt.getTime() + ttlSec * 1000);
      const username = ephemeralUsername(expiresAt);
      const access = FORGEJO_ACCESS[input.access];

      // Read first, and not only for the clone URL: a repository that is not
      // there must not result in a user account that outlives the request.
      const repository = await client.send<RepositoryResponse>({ method: 'GET', path });
      const cloneUrl = repository.body?.clone_url;
      if (cloneUrl === undefined || cloneUrl === '') {
        throw new ForgejoError('GET', path, 0, 'repository response carried no clone_url');
      }

      // Used once, below, to mint the token. Never stored, never returned, never
      // logged — Forgejo's token endpoint is the only thing that ever sees it.
      const password = randomBytes(24).toString('base64url');

      await client.send({
        method: 'POST',
        path: '/admin/users',
        body: {
          username,
          // A domain nobody can receive at, so a misconfigured mailer cannot send
          // anything anywhere. Notifications are off in every environment
          // (`app.ini`), and this is the second line of that.
          email: `${username}@ephemeral.zapp.invalid`,
          password,
          must_change_password: false,
          /**
           * The word that does the work. A restricted Forgejo user sees nothing
           * it has not been explicitly granted — not other repositories, not
           * public ones, not the organization it is a collaborator in. Without
           * it, a token scoped `read:repository` would read every repository the
           * account can see, which for an unrestricted account is a great many.
           */
          restricted: true,
          visibility: 'private',
        },
      });

      try {
        await client.send({
          method: 'PUT',
          path: `${path}/collaborators/${encodeURIComponent(username)}`,
          body: { permission: access.permission },
        });

        const minted = await client.send<TokenResponse>({
          method: 'POST',
          path: `/users/${encodeURIComponent(username)}/tokens`,
          // Basic auth as the ephemeral user: Forgejo's token endpoint refuses
          // token auth, which is the whole reason the account has a password.
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

        /**
         * The audit row, before the token is returned and after it exists.
         *
         * Deliberately in this order and inside the compensation below: a
         * credential that was handed out with no record of it is the one outcome
         * this trail exists to prevent, so if the row cannot be written the grant
         * is destroyed and the caller gets an error. The reverse order — record
         * first — would leave rows describing credentials that were never issued,
         * which is the less dangerous failure but makes the trail unreliable in
         * the other direction.
         */
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
            // The identity, not the secret: enough to tie a Forgejo access-log
            // line back to this row, and worth nothing on its own.
            tokenUser: username,
            reason: input.reason,
            runId: input.runId ?? null,
            taskId: input.taskId ?? null,
          },
        });

        return { token, username, cloneUrl, expiresAt };
      } catch (error) {
        // Everything after the account was created is compensated: a failed
        // grant must not leave a usable identity behind, and an unswept
        // ephemeral user with a token is exactly that.
        await deleteUser(username).catch(() => {
          // The sweep will find it: the deadline is in the name. Swallowed
          // rather than masking the original failure, which is the one the
          // caller needs.
        });
        throw error;
      }
    },

    async revokeForProject(input): Promise<number> {
      const ref = internalRepoRef(input);
      const collaborators = await client.send<readonly UserResponse[]>({
        method: 'GET',
        path: `${repoPath(ref)}/collaborators?limit=100`,
        // A repository that is already gone has no collaborators to revoke, and
        // "the project was deleted" is precisely when this is called.
        allow: [404],
      });

      const ephemeral = (collaborators.body ?? [])
        .map((user) => user.login ?? '')
        .filter((login) => expiryOf(login) !== undefined);

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
            reason: input.reason,
          },
        });
      }
      return ephemeral.length;
    },

    async sweepExpired(at?: Date): Promise<number> {
      const deadline = at ?? now();
      const PAGE = 50;
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
          path: `/admin/users?limit=${String(PAGE)}&page=${String(page)}`,
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
        if (batch.length < PAGE) {
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
