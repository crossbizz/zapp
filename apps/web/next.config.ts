import type { NextConfig } from 'next';
import { fileURLToPath } from 'node:url';

const configuredControlApiUrl = process.env.NEXT_PUBLIC_CONTROL_API_URL?.trim();
const controlApiUrl =
  configuredControlApiUrl === undefined || configuredControlApiUrl.length === 0
    ? process.env.NODE_ENV === 'development'
      ? 'http://localhost:4000'
      : undefined
    : configuredControlApiUrl;
const configuredDistDir = process.env.ZAPP_WEB_NEXT_DIST_DIR?.trim();
const uiSourceEntry = fileURLToPath(new URL('../../packages/ui/src/index.ts', import.meta.url));
const uiSourceTokens = fileURLToPath(new URL('../../packages/ui/src/tokens.css', import.meta.url));

const nextConfig: NextConfig = {
  allowedDevOrigins: ['127.0.0.1'],
  ...(controlApiUrl === undefined ? {} : { env: { NEXT_PUBLIC_CONTROL_API_URL: controlApiUrl } }),
  ...(configuredDistDir === undefined || configuredDistDir.length === 0
    ? {}
    : { distDir: configuredDistDir }),
  productionBrowserSourceMaps: true,
  transpilePackages: ['@zapp/ui'],
  webpack(config, { dev }) {
    if (dev) {
      config.resolve ??= {};
      if (Array.isArray(config.resolve.alias)) {
        config.resolve.alias.push(
          { name: '@zapp/ui$', alias: uiSourceEntry },
          { name: '@zapp/ui/tokens.css$', alias: uiSourceTokens },
        );
      } else {
        config.resolve.alias = {
          ...config.resolve.alias,
          '@zapp/ui$': uiSourceEntry,
          '@zapp/ui/tokens.css$': uiSourceTokens,
        };
      }
      config.watchOptions = {
        ...config.watchOptions,
        ignored: ['**/.git/**', '**/.next*/**', '**/.worktrees/**', '**/node_modules/**'],
        poll: 1_000,
      };
    }
    return config;
  },
};

export default nextConfig;
