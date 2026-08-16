import { defineConfig } from '@playwright/test';

import { appBaseUrl } from './e2e/support/ports.js';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL: appBaseUrl,
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'node --import tsx e2e/support/server.ts',
    url: `${appBaseUrl}/login`,
    reuseExistingServer: false,
    timeout: 60_000,
    gracefulShutdown: { signal: 'SIGTERM', timeout: 30_000 },
  },
});
