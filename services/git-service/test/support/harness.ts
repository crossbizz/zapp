import { createServiceTokenSigner, createTemplateRegistry, type ServiceName } from '@zapp/config';
import { internalRepoRef, newId } from '@zapp/contracts';

import { buildApp, type AppInstance } from '../../src/app.js';
import { createRecordingGitAuditSink, type RecordingGitAuditSink } from '../../src/audit.js';
import { SERVICE_TOKEN_HEADER } from '../../src/internal/service-auth.js';
import type {
  BranchRef,
  CommitDetail,
  CommitPage,
  CommitSummary,
  CreateRepositoryInput,
  CreatedRepository,
  GitProvider,
  CommitComparison,
  CommitComparisonProvider,
} from '../../src/provider/types.js';
import type { MintedToken, TokenService } from '../../src/tokens.js';
import type { GitBundleExporter } from '../../src/export.js';
import type { GitTemplateSeedInput, GitTemplateSeeder } from '../../src/template-seeder.js';

export const TEMPLATE_SOURCE_SHA = 'a57bb2926674275a84f651c64e5c995a42519b5e';
const TEST_TEMPLATES = createTemplateRegistry([{
  slug: 'next-starter',
  name: 'Next.js Starter',
  description: 'A production-ready Next.js starting point.',
  pagesIncluded: ['Home'],
  highlights: ['TypeScript included'],
  demoUrl: 'https://templates.zapp.build/next-starter/a57bb2926674/',
  stack: ['Next.js', 'React', 'TypeScript'],
  repoRef: 'https://github.com/dyad-sh/nextjs-template.git',
  commitSha: TEMPLATE_SOURCE_SHA,
}]);

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

export interface FakeGitProvider extends GitProvider, CommitComparisonProvider {
  readonly calls: readonly RecordedProviderCall[];
  /** Makes the next call to `method` throw. For proving the failure path. */
  failNext(method: string, error: Error): void;
  /** What `getBranch` answers with. `undefined` is an unborn or missing branch. */
  branch: BranchRef | undefined;
  commits: CommitSummary[];
  commit: CommitDetail | undefined;
  exists: boolean;
  comparison: CommitComparison | undefined;
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
    exists: true,
    comparison: {
      beforeSha: 'a'.repeat(40),
      afterSha: 'b'.repeat(40),
      changedFiles: 1,
      files: [{ path: 'src/index.ts', status: 'modified', additions: 1, deletions: 1 }],
      filesTruncated: false,
      patch: '@@ -1 +1 @@\n-before\n+after\n',
      patchTruncated: false,
    },

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
    repositoryExists(ref: string): Promise<boolean> {
      record('repositoryExists', ref);
      return Promise.resolve(fake.exists);
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
    compareCommits(ref: string, beforeSha: string, afterSha: string) {
      record('compareCommits', ref, beforeSha, afterSha);
      return Promise.resolve(fake.comparison);
    },
    ...overrides,
  };

  return fake;
}

export interface FakeTokenService extends TokenService {
  readonly calls: readonly RecordedProviderCall[];
  failNext(method: string, error: Error): void;
  minted: MintedToken;
  revoked: number;
}

/** A token service that records and answers, creating no Forgejo user anywhere. */
export function createFakeTokenService(): FakeTokenService {
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

  const fake: FakeTokenService = {
    calls,
    minted: {
      token: 'forgejo-token-value',
      username: 'zt-1900000000-0123456789ab',
      cloneUrl: 'https://git.test/org_x/proj_y.git',
      expiresAt: new Date('2026-02-01T00:05:00.000Z'),
    },
    revoked: 0,
    failNext(method, error) {
      failures.set(method, error);
    },
    mint(input) {
      record('mint', input);
      return Promise.resolve(fake.minted);
    },
    mintForRepository(input) {
      record('mintForRepository', input);
      return Promise.resolve(fake.minted);
    },
    revokeForProject(input) {
      record('revokeForProject', input);
      return Promise.resolve(fake.revoked);
    },
    revokeEphemeral(input) {
      record('revokeEphemeral', input);
      return Promise.resolve();
    },
    sweepExpired(now) {
      record('sweepExpired', now);
      return Promise.resolve(fake.revoked);
    },
  };
  return fake;
}

export interface Harness {
  readonly app: AppInstance;
  readonly provider: FakeGitProvider;
  readonly tokens: FakeTokenService;
  readonly audit: RecordingGitAuditSink;
  readonly templateSeeder: GitTemplateSeeder & { readonly calls: readonly GitTemplateSeedInput[] };
}

/** The app as it ships, with the provider and the token service substituted. */
export function harness(
  options: {
    readonly callers?: readonly ServiceName[];
    readonly now?: () => Date;
    readonly bundleExporter?: GitBundleExporter;
  } = {},
): Harness {
  const provider = createFakeProvider();
  const tokens = createFakeTokenService();
  const audit = createRecordingGitAuditSink();
  const seedCalls: GitTemplateSeedInput[] = [];
  const templateSeeder = {
    calls: seedCalls,
    seed(input: GitTemplateSeedInput) {
      seedCalls.push(input);
      return Promise.resolve({ headCommitSha: TEMPLATE_SOURCE_SHA });
    },
  };
  const app = buildApp({
    logger: false,
    provider,
    tokens,
    signer,
    comparison: provider,
    templates: TEST_TEMPLATES,
    templateSeeder,
    ...(options.callers === undefined ? {} : { callers: options.callers }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.bundleExporter === undefined
      ? {}
      : { bundleExporter: options.bundleExporter }),
  });
  return { app, provider, tokens, audit, templateSeeder };
}
