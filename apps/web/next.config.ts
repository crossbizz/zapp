import type { NextConfig } from 'next';

const configuredControlApiUrl = process.env.NEXT_PUBLIC_CONTROL_API_URL?.trim();
const controlApiUrl = configuredControlApiUrl === undefined || configuredControlApiUrl.length === 0
  ? process.env.NODE_ENV === 'development'
    ? 'http://localhost:4000'
    : undefined
  : configuredControlApiUrl;
const configuredDistDir = process.env.ZAPP_WEB_NEXT_DIST_DIR?.trim();

const nextConfig: NextConfig = {
  allowedDevOrigins: ['127.0.0.1'],
  ...(controlApiUrl === undefined
    ? {}
    : { env: { NEXT_PUBLIC_CONTROL_API_URL: controlApiUrl } }),
  ...(configuredDistDir === undefined || configuredDistDir.length === 0
    ? {}
    : { distDir: configuredDistDir }),
  productionBrowserSourceMaps: true,
};

export default nextConfig;
