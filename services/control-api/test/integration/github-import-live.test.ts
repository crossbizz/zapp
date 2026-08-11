import { describe, expect, it } from 'vitest';

import { createGitHubProvider } from '../../src/integrations/github/app.js';

const required = [
  'GITHUB_APP_ID',
  'GITHUB_APP_PRIVATE_KEY',
  'GITHUB_APP_CLIENT_ID',
  'GITHUB_APP_CLIENT_SECRET',
  'GITHUB_LIVE_INSTALLATION_ID',
  'GITHUB_LIVE_REPOSITORY',
  'GITHUB_LIVE_BRANCH',
] as const;
const missing = required.filter((name) => process.env[name] === undefined || process.env[name] === '');

if (missing.length > 0) {
  process.stderr.write(
    `[@zapp/control-api] GitHub import live test SKIPPED — not run, not passed: ${missing.join(', ')} are unset\n`,
  );
}

describe('live GitHub import credential boundary', () => {
  it.skipIf(missing.length > 0)(
    `acquires a short-lived installation credential for an existing branch (missing: ${missing.join(', ') || 'none'})`,
    async () => {
      const provider = createGitHubProvider({
        appId: process.env['GITHUB_APP_ID'] ?? '',
        clientId: process.env['GITHUB_APP_CLIENT_ID'] ?? '',
        clientSecret: process.env['GITHUB_APP_CLIENT_SECRET'] ?? '',
        privateKey: (process.env['GITHUB_APP_PRIVATE_KEY'] ?? '').replace(/\\n/gu, '\n'),
        ...(process.env['GITHUB_API_BASE_URL'] === undefined
          ? {}
          : { baseUrl: process.env['GITHUB_API_BASE_URL'] }),
      });

      const prepared = await provider.prepareImport({
        installationId: process.env['GITHUB_LIVE_INSTALLATION_ID'] ?? '',
        repo: process.env['GITHUB_LIVE_REPOSITORY'] ?? '',
        branch: process.env['GITHUB_LIVE_BRANCH'] ?? '',
      });

      expect(prepared.sourceCloneUrl).toMatch(/^https?:\/\//u);
      expect(prepared.sourceToken.length).toBeGreaterThan(0);
    },
  );
});
