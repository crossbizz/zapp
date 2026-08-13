import { defineConfig } from '@playwright/test';

const appPort = Number(process.env['ZAPP_WEB_E2E_APP_PORT'] ?? 3100);

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL: `http://127.0.0.1:${String(appPort)}`,
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'pnpm exec tsx e2e/support/server.ts',
    url: `http://127.0.0.1:${String(appPort)}/login`,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
