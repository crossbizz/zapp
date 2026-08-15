import { strict as assert } from 'node:assert';
import { after, before, it } from 'node:test';

const environment: Record<string, string | undefined> = process.env;
const originalNodeEnv = environment['NODE_ENV'];
const originalControlApiUrl = environment['NEXT_PUBLIC_CONTROL_API_URL'];
const originalNextDistDir = environment['ZAPP_WEB_NEXT_DIST_DIR'];

before(() => {
  environment['NODE_ENV'] = 'development';
  delete environment['NEXT_PUBLIC_CONTROL_API_URL'];
  environment['ZAPP_WEB_NEXT_DIST_DIR'] = '.next-e2e-test';
});

after(() => {
  if (originalNodeEnv === undefined) delete environment['NODE_ENV'];
  else environment['NODE_ENV'] = originalNodeEnv;

  if (originalControlApiUrl === undefined) delete environment['NEXT_PUBLIC_CONTROL_API_URL'];
  else environment['NEXT_PUBLIC_CONTROL_API_URL'] = originalControlApiUrl;

  if (originalNextDistDir === undefined) delete environment['ZAPP_WEB_NEXT_DIST_DIR'];
  else environment['ZAPP_WEB_NEXT_DIST_DIR'] = originalNextDistDir;
});

void it('connects next dev to the real local control API when no override is supplied', async () => {
  const { default: nextConfig } = await import('../next.config.js');

  assert.equal(nextConfig.env?.NEXT_PUBLIC_CONTROL_API_URL, 'http://localhost:4000');
  assert.equal(nextConfig.distDir, '.next-e2e-test');
});

void it('does not watch repository worktrees during local development', async () => {
  const { default: nextConfig } = await import('../next.config.js');

  const configureWebpack = nextConfig.webpack;
  assert.equal(typeof configureWebpack, 'function');
  assert.ok(configureWebpack);
  const configured: unknown = configureWebpack({ watchOptions: {} }, { dev: true } as never);
  assert.ok(configured !== null && typeof configured === 'object' && 'watchOptions' in configured);
  const { watchOptions } = configured;
  assert.ok(
    watchOptions !== null &&
      typeof watchOptions === 'object' &&
      'ignored' in watchOptions &&
      'poll' in watchOptions,
  );
  assert.deepEqual(watchOptions.ignored, [
    '**/.git/**',
    '**/.next*/**',
    '**/.worktrees/**',
    '**/node_modules/**',
  ]);
  assert.equal(watchOptions.poll, 1_000);
});

void it('runs one signal-owning E2E supervisor with enough time to restore generated configuration', async () => {
  const { default: playwrightConfig } = await import('../playwright.config.js');
  const webServer = Array.isArray(playwrightConfig.webServer)
    ? playwrightConfig.webServer[0]
    : playwrightConfig.webServer;

  assert.equal(webServer?.command, 'node --import tsx e2e/support/server.ts');
  assert.deepEqual(webServer.gracefulShutdown, { signal: 'SIGTERM', timeout: 30_000 });
});
