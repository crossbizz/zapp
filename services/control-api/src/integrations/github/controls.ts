import type { GitHubControlsPort } from '../../routes/integrations.js';

export function createGitHubControls(input: {
  readonly sync: { refreshProject(request: Parameters<GitHubControlsPort['refreshProject']>[0]): ReturnType<GitHubControlsPort['refreshProject']> };
  readonly exporter: { exportProject(request: Parameters<GitHubControlsPort['exportProject']>[0]): ReturnType<GitHubControlsPort['exportProject']> };
}): GitHubControlsPort {
  return {
    refreshProject: (request) => input.sync.refreshProject(request),
    exportProject: (request) => input.exporter.exportProject(request),
  };
}
