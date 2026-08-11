import { describe, expect, it } from 'vitest';

import { createGitHubProvider } from '../../src/integrations/github/app.js';

const required = [
  'GITHUB_APP_ID',
  'GITHUB_APP_PRIVATE_KEY',
  'GITHUB_APP_CLIENT_ID',
  'GITHUB_APP_CLIENT_SECRET',
  'GITHUB_LIVE_CALLBACK_CODE',
  'GITHUB_LIVE_INSTALLATION_ID',
] as const;
const missing = required.filter((name) => process.env[name] === undefined || process.env[name] === '');

if (missing.length > 0) {
  process.stderr.write(
    `[@zapp/control-api] GitHub live test SKIPPED — not run, not passed: ${missing.join(', ')} are unset\n`,
  );
}

describe('live GitHub App', () => {
  it.skipIf(missing.length > 0)(
    `verifies an installation with a real App JWT (missing: ${missing.join(', ') || 'none'})`,
    async () => {
      const provider = createGitHubProvider({
        appId: process.env['GITHUB_APP_ID'] ?? '',
        clientId: process.env['GITHUB_APP_CLIENT_ID'] ?? '',
        clientSecret: process.env['GITHUB_APP_CLIENT_SECRET'] ?? '',
        privateKey: (process.env['GITHUB_APP_PRIVATE_KEY'] ?? '').replace(/\\n/g, '\n'),
        ...(process.env['GITHUB_API_BASE_URL'] === undefined
          ? {}
          : { baseUrl: process.env['GITHUB_API_BASE_URL'] }),
      });
      await expect(
        provider.completeInstallation({
          installationId: process.env['GITHUB_LIVE_INSTALLATION_ID'] ?? '',
          code: process.env['GITHUB_LIVE_CALLBACK_CODE'] ?? '',
        }),
      ).resolves.toEqual({ installationId: process.env['GITHUB_LIVE_INSTALLATION_ID'] });
    },
  );
});
