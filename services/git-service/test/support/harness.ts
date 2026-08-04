import { createServiceTokenSigner, type ServiceName } from '@zapp/config';
import { internalRepoRef, newId } from '@zapp/contracts';

import { buildApp, type AppInstance } from '../../src/app.js';
import { SERVICE_TOKEN_HEADER } from '../../src/internal/service-auth.js';
import type {
  BranchRef,
  CommitDetail,
  CommitPage,
  CommitSummary,
  CreateRepositoryInput,
  CreatedRepository,
  GitProvider,
} from '../../src/provider/types.js';

/** Long enough to clear the HS256 floor `loadServiceTokenConfig` enforces. */
export const SERVICE_SECRET = 'test-service-secret-that-is-long-enough-32';

export const signer = createServiceTokenSigner({ secret: SERVICE_SECRET });

/** A caller's credential. `aud` is this service, which is what the gate requires. */
export async function serviceToken(
  service: ServiceName = 'control-api',
  options: {
    readonly aud?: 'git-service' | 'control-api:secrets.decrypt';
    readonly now?: Date;
  } = {},
): Promise<string> {
  const issued = await signer.signServiceToken({
    service,
    aud: options.aud ?? 'git-service',
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  return issued.token;
}

export function serviceHeaders(token: string): Record<string, string> {
  return { [SERVICE_TOKEN_HEADER]: token };
}

/** A fresh (organization, project) pair, and the ref they derive. */
export function newProject(): {
  organizationId: string;
  projectId: string;
  ref: string;
} {
  const organizationId = newId('org');
  const projectId = newId('proj');
  return { organizationId, projectId, ref: internalRepoRef({ organizationId, projectId }) };
}

export interface RecordedProviderCall {
  readonly method: string;
  readonly args: readonly unknown[];
}

export interface FakeGitProvider extends GitProvider {
  readonly calls: readonly RecordedProviderCall[];
  /** Makes the next call to `method` throw. For proving the failure path. */
  failNext(method: string, error: Error): void;
  /** What `getBranch` answers with. `undefined` is an unborn or missing branch. */
  branch: BranchRef | undefined;
  commits: CommitSummary[];
  commit: CommitDetail | undefined;
}

/**
 * A provider that records and answers, with no Forgejo anywhere near it.
 *
 * What the route suite is for: the authorization gate, the envelope, the
 * pagination and the ref derivation are all *this codebase's* behaviour, and
 * proving them against a real Git host would make them untestable without one.
 * The provider's own behaviour — idempotency, what a 404 means — is proved
 * against the real thing in `test/integration/`.
 */
export function createFakeProvider(overrides: Partial<GitProvider> = {}): FakeGitProvider {
  const calls: RecordedProviderCall[] = [];
  const failures = new Map<string, Error>();

  function record(method: string, ...args: unknown[]): void {
    calls.push({ method, args });
    const failure = failures.get(method);
    if (failure !== undefined) {
      failures.delete(method);
      throw failure;
    }
  }

  const fake: FakeGitProvider = {
    calls,
    branch: { name: 'main', headSha: 'a'.repeat(40) },
    commits: [],
    commit: undefined,

    failNext(method, error) {
      failures.set(method, error);
    },

    createRepository(input: CreateRepositoryInput): Promise<CreatedRepository> {
      record('createRepository', input);
      return Promise.resolve({
        internalRepoRef: internalRepoRef(input),
        cloneUrl: `https://git.test/${internalRepoRef(input)}.git`,
        provisionedAt: new Date('2026-02-01T00:00:00.000Z'),
      });
    },
    deleteRepository(ref: string): Promise<void> {
      record('deleteRepository', ref);
      return Promise.resolve();
    },
    createBranch(ref: string, name: string, fromSha: string): Promise<void> {
      record('createBranch', ref, name, fromSha);
      return Promise.resolve();
    },
    getBranch(ref: string, name: string): Promise<BranchRef | undefined> {
      record('getBranch', ref, name);
      return Promise.resolve(fake.branch);
    },
    protectBranch(ref: string, pattern: string): Promise<void> {
      record('protectBranch', ref, pattern);
      return Promise.resolve();
    },
    listCommits(ref: string, branch: string, page: CommitPage): Promise<CommitSummary[]> {
      record('listCommits', ref, branch, page);
      return Promise.resolve(fake.commits.slice(0, page.limit));
    },
    getCommit(ref: string, sha: string): Promise<CommitDetail | undefined> {
      record('getCommit', ref, sha);
      return Promise.resolve(fake.commit);
    },
    createTag(ref: string, tag: string, sha: string): Promise<void> {
      record('createTag', ref, tag, sha);
      return Promise.resolve();
    },
    ...overrides,
  };

  return fake;
}

export interface Harness {
  readonly app: AppInstance;
  readonly provider: FakeGitProvider;
}

/** The app as it ships, with the provider substituted. */
export function harness(
  options: { readonly callers?: readonly ServiceName[]; readonly now?: () => Date } = {},
): Harness {
  const provider = createFakeProvider();
  const app = buildApp({
    logger: false,
    provider,
    signer,
    ...(options.callers === undefined ? {} : { callers: options.callers }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  return { app, provider };
}
