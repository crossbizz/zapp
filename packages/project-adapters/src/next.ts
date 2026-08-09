import { createFrameworkAdapter, discoverNextRoutes } from './framework-shared.js';

export const nextAdapter = createFrameworkAdapter({
  id: 'next',
  configPatterns: [/^next\.config\.(js|mjs|cjs|ts)$/u],
  dependencies: ['next'],
  defaultPort: 3000,
  buildOutput: '.next',
  deploymentProvider: 'vercel',
  discoverRoutes: discoverNextRoutes,
});
