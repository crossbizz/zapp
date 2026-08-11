import type {
  GitHubBranchListInput,
  GitHubBranchPage,
  GitHubCompleteInstallationInput,
  GitHubInstallation,
  GitHubProviderFailure,
  GitHubRepositoryListInput,
  GitHubRepositoryPage,
} from './schemas.js';

export type { GitHubBranch, GitHubRepository } from './schemas.js';

export class GitHubProviderError extends Error {
  constructor(readonly failure: GitHubProviderFailure) {
    super('GitHub provider request failed');
    this.name = 'GitHubProviderError';
  }
}

export interface GitHubProviderPort {
  completeInstallation(input: GitHubCompleteInstallationInput): Promise<GitHubInstallation>;
  listRepositories(input: GitHubRepositoryListInput): Promise<GitHubRepositoryPage>;
  listBranches(input: GitHubBranchListInput): Promise<GitHubBranchPage>;
}
