import type {
  GitHubBranchListInput,
  GitHubBranchPage,
  GitHubCompleteInstallationInput,
  GitHubInstallation,
  GitHubProviderFailure,
  GitHubRepositoryListInput,
  GitHubRepositoryPage,
} from './schemas.js';
import { GitHubImportRequestSchema } from './schemas.js';
import { z } from 'zod';

export type { GitHubBranch, GitHubRepository } from './schemas.js';

export class GitHubProviderError extends Error {
  constructor(readonly failure: GitHubProviderFailure) {
    super('GitHub provider request failed');
    this.name = 'GitHubProviderError';
  }
}

export const GitHubImportProviderFailureSchema = z.enum([
  'github_unavailable',
  'repository_not_found',
  'branch_not_found',
]);
export const GitHubPrepareImportInputSchema = GitHubImportRequestSchema;
export const GitHubPreparedImportSchema = z
  .object({
    sourceCloneUrl: z
      .string()
      .url()
      .refine((value) => /^https?:\/\//u.test(value), 'sourceCloneUrl must use HTTP(S)'),
    sourceToken: z.string().min(1),
  })
  .strict();

export type GitHubImportProviderFailure = z.infer<typeof GitHubImportProviderFailureSchema>;
export type GitHubPrepareImportInput = z.infer<typeof GitHubPrepareImportInputSchema>;
export type GitHubPreparedImport = z.infer<typeof GitHubPreparedImportSchema>;

export class GitHubImportProviderError extends Error {
  constructor(readonly failure: GitHubImportProviderFailure) {
    super('GitHub import provider request failed');
    this.name = 'GitHubImportProviderError';
  }
}

/** Credential-bearing provider seam used only by the durable import worker. */
export interface GitHubImportProviderPort {
  prepareImport(input: GitHubPrepareImportInput): Promise<GitHubPreparedImport>;
}

export interface GitHubProviderPort {
  completeInstallation(input: GitHubCompleteInstallationInput): Promise<GitHubInstallation>;
  listRepositories(input: GitHubRepositoryListInput): Promise<GitHubRepositoryPage>;
  listBranches(input: GitHubBranchListInput): Promise<GitHubBranchPage>;
}
