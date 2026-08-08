import {
  ImageDigestSchema,
  ImageRecipeSchema,
  type ImageRecipe,
} from '@zapp/sandbox-service/provider-types';
import browserPackageLock from './browser/package-lock.json' with { type: 'json' };
import {
  IMAGE_BUILD_CONFIG,
  ImageBuildConfigSchema,
  type ImageBuildConfig,
} from './config.js';

const BROWSER_SIDECAR = `#!/usr/bin/env bash
set -euo pipefail
exec node /opt/zapp/browser-sidecar.mjs
`;

const BROWSER_SIDECAR_PROGRAM = `import { spawn } from 'node:child_process';
import process from 'node:process';
import { chromium } from '/opt/zapp/browser/node_modules/playwright/index.mjs';

const rawPort = process.env.ZAPP_BROWSER_CDP_PORT ?? '9222';
const port = Number(rawPort);
if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  process.stderr.write('browser sidecar received an invalid CDP port\\n');
  process.exitCode = 1;
} else {
  let launchFailed = false;
  let stopping = false;
  const browser = spawn(chromium.executablePath(), [
    '--headless=new',
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--remote-debugging-address=0.0.0.0',
    \`--remote-debugging-port=\${String(port)}\`,
    'about:blank',
  ], { stdio: 'inherit' });

  const stop = (signal) => {
    stopping = true;
    browser.kill(signal);
  };
  process.once('SIGTERM', () => stop('SIGTERM'));
  process.once('SIGINT', () => stop('SIGINT'));
  browser.once('error', () => {
    launchFailed = true;
    process.stderr.write('browser sidecar failed to launch Chromium\\n');
    process.exitCode = 1;
  });
  browser.once('exit', (code) => {
    if (launchFailed) {
      process.exitCode = 1;
    } else if (stopping) {
      process.exitCode = 0;
    } else {
      process.exitCode = code ?? 1;
    }
  });
}
`;

export function createForgeWebTestRecipe(
  untrustedBaseDigest: string,
  untrustedConfig: ImageBuildConfig = IMAGE_BUILD_CONFIG,
): ImageRecipe {
  const baseDigest = ImageDigestSchema.parse(untrustedBaseDigest);
  const config = ImageBuildConfigSchema.parse(untrustedConfig);
  const lockRoot = browserPackageLock.packages[''];
  const configuredDependencies = {
    '@axe-core/cli': config.webTest.axeCoreCli,
    playwright: config.webTest.playwright,
  };
  if (
    lockRoot.name !== config.webTest.packageName ||
    lockRoot.version !== config.webTest.packageVersion ||
    lockRoot.dependencies.playwright !== configuredDependencies.playwright ||
    lockRoot.dependencies['@axe-core/cli'] !== configuredDependencies['@axe-core/cli']
  ) {
    throw new Error('Browser package lock does not match image configuration');
  }
  const browserPackage = {
    name: config.webTest.packageName,
    version: config.webTest.packageVersion,
    private: true,
    dependencies: configuredDependencies,
  };

  return ImageRecipeSchema.parse({
    imageName: 'forge-web-test',
    base: { kind: 'publication', digest: baseDigest },
    commands: [
      'RUN apt-get update && apt-get install -y --no-install-recommends fonts-liberation fonts-noto-color-emoji fonts-noto-cjk && rm -rf /var/lib/apt/lists/*',
      'RUN npm ci --prefix /opt/zapp/browser --omit=dev --no-audit --no-fund',
      'RUN PLAYWRIGHT_BROWSERS_PATH=/ms-playwright /opt/zapp/browser/node_modules/.bin/playwright install --with-deps chromium',
      'ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright PATH=/opt/zapp/browser/node_modules/.bin:$PATH ZAPP_BROWSER_CDP_PORT=9222',
    ],
    files: [
      {
        path: '/opt/zapp/browser/package.json',
        mode: '0644',
        contents: `${JSON.stringify(browserPackage, null, 2)}\n`,
      },
      {
        path: '/opt/zapp/browser/package-lock.json',
        mode: '0644',
        contents: `${JSON.stringify(browserPackageLock, null, 2)}\n`,
      },
      {
        path: '/opt/zapp/browser-sidecar.sh',
        mode: '0755',
        contents: BROWSER_SIDECAR,
      },
      {
        path: '/opt/zapp/browser-sidecar.mjs',
        mode: '0644',
        contents: BROWSER_SIDECAR_PROGRAM,
      },
    ],
  });
}
